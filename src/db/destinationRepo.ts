import type { RowDataPacket } from 'mysql2'
import type { DbPool } from './pool.js'

export type DestinationRow = {
  id: number
  name: string
  region: string
  summary: string
  tags: unknown
}

export type FeatureRow = {
  id: number
  destination_id: number
  category: 'food' | 'scenery' | 'culture'
  title: string
  description: string
}

export async function searchDestinations(
  pool: DbPool,
  opts: { query: string; region?: string; limit: number }
): Promise<DestinationRow[]> {
  const q = `%${opts.query.trim()}%`
  const region = opts.region?.trim()
  const sql = region
    ? `
      SELECT id, name, region, summary, tags
      FROM destinations
      WHERE (name LIKE ? OR region LIKE ? OR summary LIKE ?)
        AND region LIKE ?
      ORDER BY id ASC
      LIMIT ?
    `
    : `
      SELECT id, name, region, summary, tags
      FROM destinations
      WHERE (name LIKE ? OR region LIKE ? OR summary LIKE ?)
      ORDER BY id ASC
      LIMIT ?
    `
  const params = region ? [q, q, q, `%${region}%`, opts.limit] : [q, q, q, opts.limit]
  const [rows] = await pool.query<RowDataPacket[]>(sql, params)
  return rows as DestinationRow[]
}

export async function getDestinationById(
  pool: DbPool,
  id: number
): Promise<DestinationRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, name, region, summary, tags FROM destinations WHERE id = ? LIMIT 1',
    [id]
  )
  const r = rows[0] as DestinationRow | undefined
  return r ?? null
}

export async function listDestinationIdsByRegion(
  pool: DbPool,
  regionPattern: string
): Promise<number[]> {
  const p = `%${regionPattern.trim()}%`
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM destinations WHERE region LIKE ?',
    [p]
  )
  return (rows as { id: number }[]).map((r) => r.id)
}

export async function listFeaturesByDestination(
  pool: DbPool,
  destinationId: number
): Promise<FeatureRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `
    SELECT id, destination_id, category, title, description
    FROM destination_features
    WHERE destination_id = ?
    ORDER BY category, id
    `,
    [destinationId]
  )
  return rows as FeatureRow[]
}

export async function listAllDestinations(pool: DbPool): Promise<DestinationRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, name, region, summary, tags FROM destinations ORDER BY id'
  )
  return rows as DestinationRow[]
}

export async function listAllFeatures(pool: DbPool): Promise<FeatureRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, destination_id, category, title, description FROM destination_features ORDER BY destination_id, id'
  )
  return rows as FeatureRow[]
}
