/**
 * Task 整合-2 + Task 5.4 — agent_runs / archived_run_events 仓库层
 *
 * 规划:docs/开发规划.md 整合阶段 Task 整合-2 + Task 5.4 Redis 热层改造
 * 八股:05-记忆系统.md §短期记忆(事件流水 = episodic memory 的工程形态)
 *       08-工程化实践.md §3 全链路可观测(事件日志即审计源)
 *
 * 设计要点:
 * - agent_runs:完整状态机 CRUD + 启动清理
 * - archived_run_events:冷库读写(Run 终态归档 + 续订回放)
 * - agent_run_events 旧表已从 003 migration 中移除(功能由 Redis Stream + archived_run_events 替代)
 * - seq 分配走 runManager 内存 counter(同一 Run 串行 yield 事件,无并发问题)
 * - markAllRunningAsFailed:启动时清理上次进程残留的 running 状态
 *
 * PostgreSQL 迁移说明:
 * - 占位符 ? → $1,$2...;列别名双引号保留驼峰
 * - INSERT IGNORE → ON CONFLICT (run_id, seq) DO NOTHING
 * - affectedRows → rowCount;bigint 列(last_event_seq/total_tokens)经 normalizeRunRow 转 Number
 */

import type { DbPool } from './pool.js'

export type AgentRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'cancelling'
  | 'cancelled'
  | 'failed'

export type AgentRunRow = {
  runId: string
  sessionId: string
  status: AgentRunStatus
  startedAt: Date
  finishedAt: Date | null
  lastEventSeq: number
  totalTokens: number
}

export type AgentRunEventRow = {
  seq: number
  eventJson: unknown
  createdAt: Date
}

// pg 把 bigint 列(last_event_seq/total_tokens)返回为字符串，统一转 Number
function normalizeRunRow(row: Record<string, unknown> | undefined): AgentRunRow | null {
  if (!row) return null
  return {
    runId: row.runId as string,
    sessionId: row.sessionId as string,
    status: row.status as AgentRunStatus,
    startedAt: row.startedAt as Date,
    finishedAt: (row.finishedAt ?? null) as Date | null,
    lastEventSeq: Number(row.lastEventSeq),
    totalTokens: Number(row.totalTokens)
  }
}

const RUN_COLUMNS = `run_id AS "runId", session_id AS "sessionId", status,
            started_at AS "startedAt", finished_at AS "finishedAt",
            last_event_seq AS "lastEventSeq", total_tokens AS "totalTokens"`

// ─── agent_runs ──────────────────────────────────────────────────

export async function createRun(
  pool: DbPool,
  runId: string,
  sessionId: string,
  status: AgentRunStatus = 'pending'
): Promise<void> {
  await pool.query(
    'INSERT INTO agent_runs (run_id, session_id, status) VALUES ($1, $2, $3)',
    [runId, sessionId, status]
  )
}

export async function updateRunStatus(
  pool: DbPool,
  runId: string,
  status: AgentRunStatus,
  setFinishedAt: boolean = false
): Promise<void> {
  if (setFinishedAt) {
    await pool.query(
      'UPDATE agent_runs SET status = $1, finished_at = CURRENT_TIMESTAMP WHERE run_id = $2',
      [status, runId]
    )
  } else {
    await pool.query('UPDATE agent_runs SET status = $1 WHERE run_id = $2', [status, runId])
  }
}

export async function incrementRunTokens(
  pool: DbPool,
  runId: string,
  delta: number
): Promise<void> {
  if (delta <= 0) return
  await pool.query(
    'UPDATE agent_runs SET total_tokens = total_tokens + $1 WHERE run_id = $2',
    [delta, runId]
  )
}

export async function getRunById(
  pool: DbPool,
  runId: string
): Promise<AgentRunRow | null> {
  const { rows } = await pool.query(
    `SELECT ${RUN_COLUMNS}
     FROM agent_runs WHERE run_id = $1 LIMIT 1`,
    [runId]
  )
  return normalizeRunRow(rows[0])
}

/**
 * 查指定 session 最近一次 Run（任意状态）
 * 用于 GET /sessions/:id/messages 检测是否处于 interrupted 状态
 */
export async function getLastRunBySession(
  pool: DbPool,
  sessionId: string
): Promise<AgentRunRow | null> {
  const { rows } = await pool.query(
    `SELECT ${RUN_COLUMNS}
     FROM agent_runs
     WHERE session_id = $1
     ORDER BY started_at DESC
     LIMIT 1`,
    [sessionId]
  )
  return normalizeRunRow(rows[0])
}

/**
 * 查指定 session 最近的"未完成" Run(status in 活跃集合);
 * 用于 GET /sessions/:id/runs/active —— 前端打开会话时判断是否需要续订
 */
export async function getActiveRunBySession(
  pool: DbPool,
  sessionId: string
): Promise<AgentRunRow | null> {
  const { rows } = await pool.query(
    `SELECT ${RUN_COLUMNS}
     FROM agent_runs
     WHERE session_id = $1
       AND status IN ('pending','running','cancelling')
     ORDER BY started_at DESC
     LIMIT 1`,
    [sessionId]
  )
  return normalizeRunRow(rows[0])
}

/**
 * 启动清理:把上次进程残留的活跃 Run 全部标 failed
 * (内存态 Run 不能跨进程恢复,见关键决策与边界)
 */
export async function markAllRunningAsFailed(pool: DbPool): Promise<number> {
  const res = await pool.query(
    `UPDATE agent_runs
     SET status = 'failed', finished_at = CURRENT_TIMESTAMP
     WHERE status IN ('pending','running','cancelling')`
  )
  return res.rowCount ?? 0
}

// ─── archived_run_events（Task 5.4 冷库）─────────────────────────

/**
 * Task 5.4 — 冷库批量写入(archiveAndCleanup 调用)
 * - ON CONFLICT (run_id, seq) DO NOTHING:主键冲突跳过，保证重复归档幂等
 * - 单句 multi-row INSERT:减少往返轮路;占位符按 $i 递增拼接
 */
export async function bulkInsertArchivedEvents(
  pool: DbPool,
  runId: string,
  events: { seq: number; eventJson: unknown }[]
): Promise<void> {
  if (events.length === 0) return
  const values: unknown[] = []
  const placeholders: string[] = []
  let i = 1
  for (const e of events) {
    placeholders.push(`($${i}, $${i + 1}, $${i + 2})`)
    values.push(runId, e.seq, JSON.stringify(e.eventJson))
    i += 3
  }
  await pool.query(
    `INSERT INTO archived_run_events (run_id, seq, event_json)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (run_id, seq) DO NOTHING`,
    values
  )
}

/**
 * Task 5.4 — 续订冷库查询(Redis Stream 已过期后走此路)
 * event_json 是 JSONB，pg 已自动解析为 JS 对象，直接透传
 */
export async function queryArchivedEventsAfter(
  pool: DbPool,
  runId: string,
  afterSeq: number
): Promise<AgentRunEventRow[]> {
  const { rows } = await pool.query(
    `SELECT seq, event_json AS "eventJson", created_at AS "createdAt"
     FROM archived_run_events
     WHERE run_id = $1 AND seq > $2
     ORDER BY seq ASC`,
    [runId, afterSeq]
  )
  return rows.map((r) => ({
    seq: Number(r.seq),
    eventJson: r.eventJson as unknown,
    createdAt: r.createdAt as Date
  }))
}

/**
 * Task 5.4 — 归档后一次性同步 last_event_seq
 * (原设计每事件都 UPDATE,迁 Redis 后频率骤减,此函数只在归档时调一次)
 */
export async function updateRunLastEventSeq(
  pool: DbPool,
  runId: string,
  seq: number
): Promise<void> {
  await pool.query(
    'UPDATE agent_runs SET last_event_seq = GREATEST(last_event_seq, $1) WHERE run_id = $2',
    [seq, runId]
  )
}
