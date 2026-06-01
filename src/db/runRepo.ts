/**
 * Task 整合-2 — agent_runs / agent_run_events 仓库层
 *
 * 规划:docs/开发规划.md 整合阶段 Task 整合-2
 * 八股:05-记忆系统.md §短期记忆(事件流水 = episodic memory 的工程形态)
 *       08-工程化实践.md §3 全链路可观测(事件日志即审计源)
 *
 * 设计要点:
 * - seq 分配走 runManager 内存 counter(同一 Run 串行 yield 事件,无并发问题)
 * - markAllRunningAsFailed:启动时清理上次进程残留的 running 状态
 * - 续订查询 queryEventsAfter 用 (run_id, seq) 主键,O(log n) + 顺序扫
 */

import type { RowDataPacket, ResultSetHeader } from 'mysql2'
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

// ─── agent_runs ──────────────────────────────────────────────────

export async function createRun(
  pool: DbPool,
  runId: string,
  sessionId: string,
  status: AgentRunStatus = 'pending'
): Promise<void> {
  await pool.query(
    'INSERT INTO agent_runs (run_id, session_id, status) VALUES (?, ?, ?)',
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
      'UPDATE agent_runs SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE run_id = ?',
      [status, runId]
    )
  } else {
    await pool.query('UPDATE agent_runs SET status = ? WHERE run_id = ?', [status, runId])
  }
}

export async function incrementRunTokens(
  pool: DbPool,
  runId: string,
  delta: number
): Promise<void> {
  if (delta <= 0) return
  await pool.query(
    'UPDATE agent_runs SET total_tokens = total_tokens + ? WHERE run_id = ?',
    [delta, runId]
  )
}

export async function getRunById(
  pool: DbPool,
  runId: string
): Promise<AgentRunRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT run_id AS runId, session_id AS sessionId, status,
            started_at AS startedAt, finished_at AS finishedAt,
            last_event_seq AS lastEventSeq, total_tokens AS totalTokens
     FROM agent_runs WHERE run_id = ? LIMIT 1`,
    [runId]
  )
  return (rows[0] as AgentRunRow | undefined) ?? null
}

/**
 * 查指定 session 最近的"未完成" Run(status in 活跃集合);
 * 用于 GET /sessions/:id/runs/active —— 前端打开会话时判断是否需要续订
 */
export async function getActiveRunBySession(
  pool: DbPool,
  sessionId: string
): Promise<AgentRunRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT run_id AS runId, session_id AS sessionId, status,
            started_at AS startedAt, finished_at AS finishedAt,
            last_event_seq AS lastEventSeq, total_tokens AS totalTokens
     FROM agent_runs
     WHERE session_id = ?
       AND status IN ('pending','running','cancelling')
     ORDER BY started_at DESC
     LIMIT 1`,
    [sessionId]
  )
  return (rows[0] as AgentRunRow | undefined) ?? null
}

/**
 * 启动清理:把上次进程残留的活跃 Run 全部标 failed
 * (内存态 Run 不能跨进程恢复,见关键决策与边界)
 */
export async function markAllRunningAsFailed(pool: DbPool): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(
    `UPDATE agent_runs
     SET status = 'failed', finished_at = CURRENT_TIMESTAMP
     WHERE status IN ('pending','running','cancelling')`
  )
  return res.affectedRows
}

// ─── agent_run_events ────────────────────────────────────────────

/**
 * 追加事件;seq 由调用方(runManager 内存 counter)分配,确保单调递增
 * 同步更新 agent_runs.last_event_seq 便于续订时秒查
 */
export async function appendEvent(
  pool: DbPool,
  runId: string,
  seq: number,
  eventJson: unknown
): Promise<void> {
  await pool.query(
    'INSERT INTO agent_run_events (run_id, seq, event_json) VALUES (?, ?, ?)',
    [runId, seq, JSON.stringify(eventJson)]
  )
  // 同步 last_event_seq 用 GREATEST 避免乱序 update 倒退(几乎不会发生,但稳)
  await pool.query(
    'UPDATE agent_runs SET last_event_seq = GREATEST(last_event_seq, ?) WHERE run_id = ?',
    [seq, runId]
  )
}

/**
 * 续订查询:取 seq > afterSeq 的全部事件,顺序回放
 */
export async function queryEventsAfter(
  pool: DbPool,
  runId: string,
  afterSeq: number
): Promise<AgentRunEventRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT seq, event_json AS eventJson, created_at AS createdAt
     FROM agent_run_events
     WHERE run_id = ? AND seq > ?
     ORDER BY seq ASC`,
    [runId, afterSeq]
  )
  // mysql2 的 JSON 列已自动反序列化
  return rows.map((r) => ({
    seq: r.seq as number,
    eventJson: r.eventJson as unknown,
    createdAt: r.createdAt as Date
  }))
}
