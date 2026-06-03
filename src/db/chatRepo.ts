import type { RowDataPacket } from 'mysql2'
import type { DbPool } from './pool.js'

export type ChatRole = 'user' | 'assistant' | 'system'

export async function createSession(pool: DbPool, id: string): Promise<void> {
  await pool.query('INSERT INTO chat_sessions (id) VALUES (?)', [id])
}

export async function sessionExists(pool: DbPool, id: string): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM chat_sessions WHERE id = ? LIMIT 1',
    [id]
  )
  return rows.length > 0
}

export type ChatMessageRow = {
  role: ChatRole
  content: string
}

export async function listRecentMessages(
  pool: DbPool,
  sessionId: string,
  limit: number
): Promise<ChatMessageRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `
    SELECT role, content
    FROM chat_messages
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
    `,
    [sessionId, limit]
  )
  const list = rows as ChatMessageRow[]
  return list.reverse()
}

export type SessionRow = {
  id: string
  title: string | null
  totalTokens: number
  createdAt: string
}

export async function listSessions(pool: DbPool): Promise<SessionRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, title, total_tokens AS totalTokens, created_at AS createdAt FROM chat_sessions ORDER BY created_at DESC'
  )
  return rows as SessionRow[]
}

export async function getSessionMessages(
  pool: DbPool,
  sessionId: string
): Promise<ChatMessageRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC',
    [sessionId]
  )
  return rows as ChatMessageRow[]
}

export async function updateSessionTitle(
  pool: DbPool,
  sessionId: string,
  title: string
): Promise<void> {
  await pool.query(
    'UPDATE chat_sessions SET title = ? WHERE id = ?',
    [title, sessionId]
  )
}

export async function updateSessionTokens(
  pool: DbPool,
  sessionId: string,
  tokens: number
): Promise<void> {
  await pool.query(
    'UPDATE chat_sessions SET total_tokens = total_tokens + ? WHERE id = ?',
    [tokens, sessionId]
  )
}

export async function insertMessage(
  pool: DbPool,
  sessionId: string,
  role: ChatRole,
  content: string
): Promise<void> {
  await pool.query(
    'INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)',
    [sessionId, role, content]
  )
}

/**
 * 八股:05-记忆系统.md §3.2.2 CRUD「删」
 * chat_messages 通过 FK ON DELETE CASCADE 自动级联清理(见 001_init.sql:36)
 */
export async function deleteSession(pool: DbPool, id: string): Promise<void> {
  await pool.query('DELETE FROM chat_sessions WHERE id = ?', [id])
}

// ─── Task 整合-2:status 字段(简化版,'running'|'end') ────────────
// 注:这是 chat_sessions 上的"该 session 是否有活跃 Run"快照;
// 真正完整状态机在 agent_runs.status 上(见 src/db/runRepo.ts)

export type SessionStatus = 'running' | 'end'

export async function updateSessionStatus(
  pool: DbPool,
  sessionId: string,
  status: SessionStatus
): Promise<void> {
  await pool.query('UPDATE chat_sessions SET status = ? WHERE id = ?', [status, sessionId])
}

export async function getSessionStatus(
  pool: DbPool,
  sessionId: string
): Promise<SessionStatus | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT status FROM chat_sessions WHERE id = ? LIMIT 1',
    [sessionId]
  )
  return ((rows[0] as { status?: SessionStatus })?.status ?? null) as SessionStatus | null
}

/**
 * 启动清理:把上次进程残留的 'running' session 全部标 'end'
 * 跟 runRepo.markAllRunningAsFailed 配对调用
 */
export async function markAllSessionsAsEnd(pool: DbPool): Promise<number> {
  const [res] = await pool.query<import('mysql2').ResultSetHeader>(
    "UPDATE chat_sessions SET status = 'end' WHERE status = 'running'"
  )
  return res.affectedRows
}

/**
 * Task 整合-2:流式中 assistant 消息**增量 UPDATE 同一行**
 * 而不是每 token 一条 INSERT —— 避免行数爆炸,且续订时拿"已写的部分"
 * 返回:首次写入的消息 id;调用方需保留 id 后续 update 用
 */
export async function insertAssistantStub(
  pool: DbPool,
  sessionId: string
): Promise<number> {
  const [res] = await pool.query<import('mysql2').ResultSetHeader>(
    "INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', '')",
    [sessionId]
  )
  return res.insertId
}

export async function updateAssistantContent(
  pool: DbPool,
  messageId: number,
  content: string
): Promise<void> {
  await pool.query('UPDATE chat_messages SET content = ? WHERE id = ?', [content, messageId])
}

// ─── Task 4.3:会话级记忆摘要 ────────────────────────────────────

export async function updateSessionSummary(
  pool: DbPool,
  sessionId: string,
  summary: string
): Promise<void> {
  await pool.query('UPDATE chat_sessions SET summary = ? WHERE id = ?', [summary, sessionId])
}

export async function getSessionSummary(
  pool: DbPool,
  sessionId: string
): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT summary FROM chat_sessions WHERE id = ? LIMIT 1',
    [sessionId]
  )
  return (rows[0] as { summary?: string | null })?.summary ?? null
}
