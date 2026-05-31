/**
 * Task 3.1 — 从 destinations + destination_features 表生成 Chunk
 *
 * 规划:docs/开发规划.md Task 3.1(按目的地摘要 / 美食 / 美景 / 文化分别切 chunk,保留元数据)
 * 八股:03-RAG技术.md §2 切分策略(短文本不切,长文本按句切;本项目数据短,1 条 1 chunk)
 *
 * 切分策略:
 * - destinations.summary → 1 个 chunk(category='summary')
 * - destination_features 每条 → 1 个 chunk(category 对齐 food/scenery/culture)
 * - 不做 overlap:条目独立,无上下文关联;overlap 反而引入噪声
 * - chunk.text 拼接 destination 名 + 类别 + 条目内容,提升检索匹配率
 */

import type { RowDataPacket } from 'mysql2'
import type { DbPool } from '../db/pool.js'
import type { Chunk, ChunkCategory } from './types.js'

type DestRow = RowDataPacket & {
  id: number
  name: string
  region: string
  summary: string
}

type FeatureRow = RowDataPacket & {
  id: number
  destination_id: number
  category: ChunkCategory
  title: string
  description: string
  dest_name: string
  region: string
}

export async function buildAllChunks(pool: DbPool): Promise<Chunk[]> {
  const chunks: Chunk[] = []

  // ── summary chunks ──
  const [destRows] = await pool.query<DestRow[]>(
    'SELECT id, name, region, summary FROM destinations'
  )
  for (const d of destRows) {
    chunks.push({
      id: `dest${d.id}-summary-0`,
      text: `${d.name}(${d.region}):${d.summary}`,
      metadata: {
        destinationId: d.id,
        destinationName: d.name,
        region: d.region,
        category: 'summary',
        source: 'summary'
      }
    })
  }

  // ── feature chunks ──
  const [featRows] = await pool.query<FeatureRow[]>(
    `SELECT f.id, f.destination_id, f.category, f.title, f.description,
            d.name AS dest_name, d.region
     FROM destination_features f
     JOIN destinations d ON d.id = f.destination_id`
  )
  for (const f of featRows) {
    chunks.push({
      id: `dest${f.destination_id}-${f.category}-${f.id}`,
      // 加上目的地名 + 类别前缀,让 chunk 文本自带"我是什么、属于哪"的上下文
      text: `${f.dest_name}的${categoryLabel(f.category)}「${f.title}」:${f.description}`,
      metadata: {
        destinationId: f.destination_id,
        destinationName: f.dest_name,
        region: f.region,
        category: f.category,
        source: 'feature'
      }
    })
  }

  return chunks
}

function categoryLabel(cat: ChunkCategory): string {
  switch (cat) {
    case 'food': return '美食'
    case 'scenery': return '美景'
    case 'culture': return '文化'
    case 'summary': return '概览'
  }
}
