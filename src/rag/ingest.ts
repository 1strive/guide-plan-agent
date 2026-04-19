import { createHash } from 'node:crypto'
import type { DbPool } from '../db/pool.js'
import { listAllDestinations, listAllFeatures } from '../db/destinationRepo.js'

export type ChunkPayload = {
  destination_id: number
  source: 'summary' | 'feature' | 'synthetic'
  chunk_text: string
  content_hash: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function tagsToString(tags: unknown): string {
  if (tags == null) return ''
  if (Array.isArray(tags)) return tags.join('、')
  if (typeof tags === 'string') {
    try {
      const p = JSON.parse(tags) as unknown
      return Array.isArray(p) ? p.join('、') : String(tags)
    } catch {
      return tags
    }
  }
  return String(tags)
}

export async function buildChunkPayloads(pool: DbPool): Promise<ChunkPayload[]> {
  const destinations = await listAllDestinations(pool)
  const features = await listAllFeatures(pool)
  const byDest = new Map<number, typeof features>()
  for (const f of features) {
    const list = byDest.get(f.destination_id) ?? []
    list.push(f)
    byDest.set(f.destination_id, list)
  }

  const chunks: ChunkPayload[] = []

  for (const d of destinations) {
    const tagStr = tagsToString(d.tags)
    const summaryText = `目的地：${d.name}（${d.region}）。${d.summary} 标签：${tagStr}`
    chunks.push({
      destination_id: d.id,
      source: 'summary',
      chunk_text: summaryText,
      content_hash: sha256(summaryText)
    })

    const feats = byDest.get(d.id) ?? []
    const lines = feats.map(
      (f) => `[${f.category}] ${f.title}：${f.description}`
    )
    const syntheticText = `目的地：${d.name}（${d.region}）要点：\n${lines.join('\n')}`
    chunks.push({
      destination_id: d.id,
      source: 'synthetic',
      chunk_text: syntheticText,
      content_hash: sha256(syntheticText)
    })

    for (const f of feats) {
      const ft = `[${f.category}] ${d.name} · ${f.title}：${f.description}`
      chunks.push({
        destination_id: d.id,
        source: 'feature',
        chunk_text: ft,
        content_hash: sha256(ft)
      })
    }
  }

  return chunks
}
