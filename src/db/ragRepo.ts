import type { RowDataPacket } from 'mysql2'
import type { DbPool } from './pool.js'
import { topKCosine } from '../rag/similarity.js'
import type { AppConfig } from '../config.js'
import { embedQuery } from '../rag/embed.js'

export type RagChunkRow = {
  id: number
  destination_id: number
  source: string
  chunk_text: string
  embedding: number[]
}

function parseEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => Number(x))
  }
  if (typeof raw === 'string') {
    return JSON.parse(raw) as number[]
  }
  throw new Error('invalid embedding')
}

export async function truncateRagChunks(pool: DbPool): Promise<void> {
  await pool.query('DELETE FROM rag_chunks')
}

export async function insertRagChunk(
  pool: DbPool,
  row: {
    destination_id: number
    source: string
    chunk_text: string
    embedding: number[]
    content_hash: string
  }
): Promise<void> {
  await pool.query(
    `
    INSERT INTO rag_chunks (destination_id, source, chunk_text, embedding, content_hash)
    VALUES (?, ?, ?, CAST(? AS JSON), ?)
    `,
    [
      row.destination_id,
      row.source,
      row.chunk_text,
      JSON.stringify(row.embedding),
      row.content_hash
    ]
  )
}

export async function loadChunksForSemanticSearch(
  pool: DbPool,
  opts: { destinationIds?: number[]; candidateLimit: number }
): Promise<RagChunkRow[]> {
  if (opts.destinationIds && opts.destinationIds.length === 0) {
    return []
  }
  if (opts.destinationIds && opts.destinationIds.length > 0) {
    const placeholders = opts.destinationIds.map(() => '?').join(',')
    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT id, destination_id, source, chunk_text, embedding
      FROM rag_chunks
      WHERE destination_id IN (${placeholders})
      LIMIT ?
      `,
      [...opts.destinationIds, opts.candidateLimit]
    )
    return (rows as RowDataPacket[]).map((r) => ({
      id: Number(r.id),
      destination_id: Number(r.destination_id),
      source: String(r.source),
      chunk_text: String(r.chunk_text),
      embedding: parseEmbedding(r.embedding)
    }))
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `
    SELECT id, destination_id, source, chunk_text, embedding
    FROM rag_chunks
    LIMIT ?
    `,
    [opts.candidateLimit]
  )
  return (rows as RowDataPacket[]).map((r) => ({
    id: Number(r.id),
    destination_id: Number(r.destination_id),
    source: String(r.source),
    chunk_text: String(r.chunk_text),
    embedding: parseEmbedding(r.embedding)
  }))
}

export async function semanticSearchTravel(
  pool: DbPool,
  config: AppConfig,
  opts: { query: string; top_k?: number; region?: string }
): Promise<
  Array<{
    score: number
    chunk_id: number
    destination_id: number
    source: string
    chunk_text: string
  }>
> {
  const topK = opts.top_k ?? config.RAG_TOP_K_DEFAULT
  let destinationIds: number[] | undefined
  if (opts.region?.trim()) {
    const [idr] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM destinations WHERE region LIKE ? LIMIT 500',
      [`%${opts.region.trim()}%`]
    )
    destinationIds = (idr as { id: number }[]).map((x) => x.id)
    if (destinationIds.length === 0) {
      return []
    }
  }
  const queryVec = await embedQuery(config, opts.query)
  const chunks = await loadChunksForSemanticSearch(pool, {
    destinationIds,
    candidateLimit: config.RAG_CANDIDATE_LIMIT
  })
  const scored = topKCosine(
    queryVec,
    chunks.map((c) => ({
      embedding: c.embedding,
      value: c
    })),
    topK
  )
  return scored.map((s) => ({
    score: s.score,
    chunk_id: s.value.id,
    destination_id: s.value.destination_id,
    source: s.value.source,
    chunk_text: s.value.chunk_text
  }))
}
