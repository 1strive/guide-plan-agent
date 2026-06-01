/**
 * Task 3.7 — Tavily 联网搜索结果缓存
 *
 * 规划:docs/开发规划.md 整合阶段后 阶段3 续 Task 3.7
 * 八股:04-工具调用.md §5 缓存与配额
 *
 * 设计要点:
 * - cache_key = SHA-256(query + depth):同 query+depth 直接复用,避免重复烧 Tavily 额度
 * - TTL 检查在应用层做(`config.WEB_SEARCH_CACHE_TTL_SECONDS`,默认 24h),
 *   过期记录不主动删,下次写入时 INSERT...ON DUPLICATE KEY UPDATE 覆盖
 * - 失效记录不阻塞下次查询:get 命中过期 → 返回 null → 调用方走真实 API
 */

import { createHash } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import type { DbPool } from '../db/pool.js'

export function buildCacheKey(query: string, depth: string): string {
  return createHash('sha256').update(`${query}::${depth}`).digest('hex')
}

/**
 * 查缓存;命中且未过期返回 response,否则 null
 */
export async function getCached(
  pool: DbPool,
  cacheKey: string,
  ttlSeconds: number
): Promise<unknown | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT response_json AS responseJson,
            TIMESTAMPDIFF(SECOND, created_at, CURRENT_TIMESTAMP) AS ageSeconds
     FROM web_search_cache
     WHERE cache_key = ?
     LIMIT 1`,
    [cacheKey]
  )
  const row = rows[0] as { responseJson: unknown; ageSeconds: number } | undefined
  if (!row) return null
  if (row.ageSeconds > ttlSeconds) return null
  // mysql2 自动反序列化 JSON 列
  return row.responseJson
}

export async function setCached(
  pool: DbPool,
  cacheKey: string,
  response: unknown
): Promise<void> {
  await pool.query(
    `INSERT INTO web_search_cache (cache_key, response_json)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE response_json = VALUES(response_json), created_at = CURRENT_TIMESTAMP`,
    [cacheKey, JSON.stringify(response)]
  )
}
