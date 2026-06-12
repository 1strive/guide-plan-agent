/**
 * Task 5.4 — Redis 事件存储层(agent_run_events 高频写 + 跨进程广播预留)
 *
 * 规划:docs/开发规划.md Task 5.4
 * 八股:docs/01-面试八股文/05-记忆系统.md §短期记忆事件流(episodic memory)
 *       docs/01-面试八股文/08-工程化实践.md §4 缓存与热层(冷热分层归档)
 *
 * 设计要点:
 * - 热层:Redis Stream `run:{runId}:events` 承担流式期所有事件 append
 * - 跨进程广播:同步 PUBLISH 到 `run:{runId}:channel`(本期仅 PUBLISH 不 SUBSCRIBE,为多副本铺路)
 * - seq 兼容:沿用 RunHandle.seqCounter 应用层自增,作为 Stream ID `{seq}-0` 显式写入
 *   → 同 runId 下乱序 XADD 会被 Redis 拒绝(等价 MySQL PRIMARY KEY 保护)
 *   → 前端续订游标(after_seq=N)语义零变更
 * - 冷归档:Run 终态时整段 XRANGE → 批量 INSERT archived_run_events → EXPIRE Stream(不 DEL)
 *   → 1h 缓冲期内续订仍能命中 Redis(零延迟);过期后自动清理,内存占用受控
 * - 失败保留:归档失败不抛错给业务,Stream 保留供启动清理或后续重试
 *   → INSERT IGNORE 保证重复归档幂等
 */

import type { RedisClient } from './pool.js'
import type { DbPool } from '../db/pool.js'
import { bulkInsertArchivedEvents, updateRunLastEventSeq } from '../db/runRepo.js'

const STREAM_KEY = (runId: string): string => `run:${runId}:events`
const CHANNEL_KEY = (runId: string): string => `run:${runId}:channel`
const STREAM_FIELD = 'e' // Stream entry 字段名(事件 JSON 存这里)

/**
 * 追加事件到 Redis Stream + 同步 PUBLISH
 * - XADD 用 `{seq}-0` 显式 ID:同 runId 下 seq 必须严格递增,Redis 拒绝乱序写
 * - PUBLISH 失败不抛错(Pub/Sub 是最佳努力,Stream 是单一信源)
 */
export async function appendEvent(
  redis: RedisClient,
  runId: string,
  seq: number,
  event: unknown
): Promise<void> {
  const json = JSON.stringify(event)
  await redis.xadd(STREAM_KEY(runId), `${seq}-0`, STREAM_FIELD, json)
  // PUBLISH 失败不抛(订阅端仅多副本场景需要,本期单进程内存订阅是主路径)
  redis.publish(CHANNEL_KEY(runId), json).catch(() => {
    /* ignore */
  })
}

/**
 * 续订查询:取 seq > afterSeq 的全部事件,顺序回放
 * - XRANGE 的 `(` 前缀表示 exclusive(不含起点)
 * - 返回的 streamId 形如 "12-0",前面部分就是 seq
 */
export async function queryEventsAfter(
  redis: RedisClient,
  runId: string,
  afterSeq: number
): Promise<{ seq: number; eventJson: unknown }[]> {
  // ioredis xrange 返回 [[id, [field, value, ...]], ...]
  const rows = (await redis.xrange(STREAM_KEY(runId), `(${afterSeq}-0`, '+')) as [
    string,
    string[]
  ][]
  return rows.map(([id, fields]) => {
    const seq = Number(id.split('-')[0])
    // fields 是 [field1, value1, field2, value2, ...] 扁平数组
    const idx = fields.indexOf(STREAM_FIELD)
    const json = idx >= 0 ? fields[idx + 1] ?? '{}' : '{}'
    return { seq, eventJson: JSON.parse(json) }
  })
}

/**
 * 判断 Stream 是否存在(活跃期或归档后 1h 缓冲期内为 true)
 * subscribe 用此函数决定走 Redis 还是冷库
 */
export async function streamExists(
  redis: RedisClient,
  runId: string
): Promise<boolean> {
  const exists = await redis.exists(STREAM_KEY(runId))
  return exists === 1
}

/**
 * 终态归档:XRANGE 全段 → 批量 INSERT archived_run_events → EXPIRE Stream
 *
 * 失败处理:
 * - INSERT 失败 → 抛错给调用方,Stream 不动(保留供下次重试)
 * - EXPIRE 失败 → 不抛(数据已落库,Stream 残留下次启动清理会兜底)
 *
 * 幂等性:
 * - bulkInsertArchivedEvents 用 INSERT IGNORE,主键冲突跳过
 * - 重复归档安全(EXPIRE 重置 TTL 也无副作用)
 */
export async function archiveAndCleanup(
  redis: RedisClient,
  pool: DbPool,
  runId: string,
  ttlSec: number
): Promise<void> {
  const rows = (await redis.xrange(STREAM_KEY(runId), '-', '+')) as [string, string[]][]
  if (rows.length === 0) {
    // Stream 不存在或为空,直接返回
    return
  }
  const events = rows.map(([id, fields]) => {
    const seq = Number(id.split('-')[0])
    const idx = fields.indexOf(STREAM_FIELD)
    const json = idx >= 0 ? fields[idx + 1] ?? '{}' : '{}'
    return { seq, eventJson: JSON.parse(json) }
  })
  // 批量入冷库(INSERT IGNORE 保证幂等)
  await bulkInsertArchivedEvents(pool, runId, events)
  // 同步 last_event_seq(取最大 seq);失败不影响归档主流程
  const maxSeq = events.reduce((m: number, e: { seq: number }) => (e.seq > m ? e.seq : m), 0)
  await updateRunLastEventSeq(pool, runId, maxSeq).catch(() => {
    /* tolerated */
  })
  // 设 TTL 让 1h 内续订仍命中 Redis;到期自动 DEL,内存占用受控
  await redis.expire(STREAM_KEY(runId), ttlSec).catch(() => {
    /* tolerated */
  })
}

/**
 * 启动清理:扫描所有残留 stream(上次进程崩溃未归档的 Run)
 * 注意 SCAN 是渐进式遍历,适合大 keyspace,不会阻塞 Redis
 */
export async function listOrphanRuns(redis: RedisClient): Promise<string[]> {
  const runIds: string[] = []
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'run:*:events', 'COUNT', 100)
    for (const key of keys) {
      // key 形如 run:{uuid}:events
      const parts = key.split(':')
      if (parts.length === 3 && parts[1]) runIds.push(parts[1])
    }
    cursor = next
  } while (cursor !== '0')
  return runIds
}
