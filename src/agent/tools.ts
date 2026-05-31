import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import {
  getDestinationById,
  listFeaturesByDestination,
  searchDestinations
} from '../db/destinationRepo.js'
import { createVectorStore, type VectorStore } from '../rag/vectorStore.js'
import type { ChunkCategory } from '../rag/types.js'
import { detectInjection, wrapUntrusted } from './sanitize.js'


export type ToolSource = {
  destinationId: number
  destinationName: string
  region: string
  via: 'search_destinations' | 'get_destination_detail' | 'semantic_search_travel'
}

export type ToolRunResult = {
  text: string
  referencedDestinationIds: number[]
  // Task 3.5:工具调用引用过的目的地来源,llm.ts 聚合后挂到 RUN_FINISHED.sources
  sources?: ToolSource[]
}

// Task 3.3:vectorStore 模块级 lazy 单例,避免每次 tool 调用都重建 Chroma client
// 安全:Chroma client 内部是 HTTP keep-alive,多次复用更省;不存在多 config 共存场景
let _vectorStore: VectorStore | null = null
function getVectorStore(config: AppConfig): VectorStore {
  if (!_vectorStore) _vectorStore = createVectorStore(config)
  return _vectorStore
}

const definitions = [
  {
    type: 'function' as const,
    function: {
      name: 'search_destinations',
      description:
        '按关键词或偏好做结构化检索（名称、地区、摘要等 LIKE 匹配）。适合用户能说出较明确词或地区时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词或偏好描述' },
          region: { type: 'string', description: '可选：地区/省份筛选' },
          limit: { type: 'integer', description: '返回条数上限', default: 10 }
        },
        required: ['query']
      }
    }
  },

  {
    type: 'function' as const,
    function: {
      name: 'get_destination_detail',
      description:
        '读取某一目的地的结构化详情，并枚举美食、美景、文化条目。列举事实时必须调用。',
      parameters: {
        type: 'object',
        properties: {
          destination_id: { type: 'integer', description: '目的地 id' }
        },
        required: ['destination_id']
      }
    }
  },

  // Task 3.3:语义检索工具,RAG 入口
  {
    type: 'function' as const,
    function: {
      name: 'semantic_search_travel',
      description:
        '按自然语言"感觉/偏好/灵感"做向量语义检索(例如「想看雪山又不想太累」「适合带娃的慢节奏目的地」)。当用户描述模糊或难以用关键词表达时优先使用此工具。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '自然语言需求描述' },
          topK: { type: 'integer', description: '返回 Top-K 条结果', default: 5 },
          category: {
            type: 'string',
            enum: ['summary', 'food', 'scenery', 'culture'],
            description: '可选:仅检索某一类内容(摘要/美食/美景/文化)'
          }
        },
        required: ['query']
      }
    }
  }
]

export function getToolDefinitions() {
  return definitions
}

type ToolArgs =
  | { name: 'search_destinations'; args: { query: string; region?: string; limit?: number } }
  | { name: 'get_destination_detail'; args: { destination_id: number } }
  | { name: 'semantic_search_travel'; args: { query: string; topK?: number; category?: ChunkCategory } }

function parseArgs(name: string, raw: string): ToolArgs {
  const j = JSON.parse(raw) as Record<string, unknown>
  if (name === 'search_destinations') {
    return {
      name,
      args: {
        query: String(j.query ?? ''),
        region: j.region != null ? String(j.region) : undefined,
        limit: j.limit != null ? Number(j.limit) : 10
      }
    }
  }
  if (name === 'get_destination_detail') {
    const destination_id = Number(j.destination_id)
    if (!Number.isFinite(destination_id)) {
      throw new Error('invalid destination_id')
    }
    return {
      name,
      args: { destination_id }
    }
  }
  if (name === 'semantic_search_travel') {
    const cat = j.category != null ? String(j.category) : undefined
    const validCats: ChunkCategory[] = ['summary', 'food', 'scenery', 'culture']
    return {
      name,
      args: {
        query: String(j.query ?? ''),
        topK: j.topK != null ? Number(j.topK) : 5,
        category: cat && (validCats as string[]).includes(cat) ? (cat as ChunkCategory) : undefined
      }
    }
  }
  throw new Error(`unknown tool: ${name}`)
}

export async function runTool(
  pool: DbPool,
  config: AppConfig,
  name: string,
  argumentsJson: string
): Promise<ToolRunResult> {
  const parsed = parseArgs(name, argumentsJson)
  if (parsed.name === 'search_destinations') {
    const limit = Math.min(Math.max(parsed.args.limit ?? 10, 1), 50)
    const rows = await searchDestinations(pool, {
      query: parsed.args.query,
      region: parsed.args.region,
      limit
    })
    const ids = rows.map((r) => r.id)
    return {
      text: JSON.stringify({
        destinations: rows.map((r) => ({
          id: r.id,
          name: r.name,
          region: r.region,
          summary: r.summary,
          tags: r.tags
        }))
      }),
      referencedDestinationIds: ids,
      sources: rows.map((r) => ({
        destinationId: r.id,
        destinationName: r.name,
        region: r.region,
        via: 'search_destinations' as const
      }))
    }
  }
  if (parsed.name === 'semantic_search_travel') {
    // Task 3.3:语义检索 → Chroma 取 Top-K chunk
    const topK = Math.min(Math.max(parsed.args.topK ?? 5, 1), 20)
    const filter = parsed.args.category ? { category: parsed.args.category } : undefined
    const results = await getVectorStore(config).query(parsed.args.query, topK, filter)

    // 阶段2 §5.6 / note-02 §5.6 留下的 RAG 间接注入防御要求:
    // 检索回来的 chunk 文本也可能含恶意指令(网页/文档来源),命中则用 <untrusted_user_content> 包裹
    // 当前数据来自自家 seed,理论上不会命中——但代码必须就位,等阶段3 接外部源时直接生效
    const safeChunks = results.map((r) => {
      const inj = detectInjection(r.text)
      return {
        id: r.id,
        destinationId: r.metadata.destinationId,
        destinationName: r.metadata.destinationName,
        region: r.metadata.region,
        category: r.metadata.category,
        distance: Number(r.distance.toFixed(4)),
        text: inj.matched ? wrapUntrusted(r.text) : r.text,
        // 命中时挂个标记,Task 3.5 溯源时可以提示用户"该来源已隔离"
        injectionDetected: inj.matched ? inj.severity : undefined
      }
    })

    const refIds = Array.from(new Set(results.map((r) => r.metadata.destinationId)))
    // 按 destinationId 去重收集 source(每个目的地只算一次,即使被多个 chunk 命中)
    const seenIds = new Set<number>()
    const sources: ToolSource[] = []
    for (const r of results) {
      if (seenIds.has(r.metadata.destinationId)) continue
      seenIds.add(r.metadata.destinationId)
      sources.push({
        destinationId: r.metadata.destinationId,
        destinationName: r.metadata.destinationName,
        region: r.metadata.region,
        via: 'semantic_search_travel'
      })
    }
    return {
      text: JSON.stringify({
        query: parsed.args.query,
        chunks: safeChunks
      }),
      referencedDestinationIds: refIds,
      sources
    }
  }
  if (parsed.name === 'get_destination_detail') {
    const dest = await getDestinationById(pool, parsed.args.destination_id)
    if (!dest) {
      return {
        text: JSON.stringify({ error: 'destination not found', destination_id: parsed.args.destination_id }),
        referencedDestinationIds: []
      }
    }
    const feats = await listFeaturesByDestination(pool, parsed.args.destination_id)
    const grouped = {
      food: [] as { title: string; description: string }[],
      scenery: [] as { title: string; description: string }[],
      culture: [] as { title: string; description: string }[]
    }
    for (const f of feats) {
      grouped[f.category].push({ title: f.title, description: f.description })
    }
    return {
      text: JSON.stringify({
        destination: {
          id: dest.id,
          name: dest.name,
          region: dest.region,
          summary: dest.summary,
          tags: dest.tags
        },
        features: grouped
      }),
      referencedDestinationIds: [dest.id],
      sources: [{
        destinationId: dest.id,
        destinationName: dest.name,
        region: dest.region,
        via: 'get_destination_detail' as const
      }]
    }
  }
  throw new Error(`unknown tool: ${name}`)
}
