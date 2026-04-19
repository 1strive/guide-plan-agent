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
