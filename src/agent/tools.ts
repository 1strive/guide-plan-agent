import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import {
  getDestinationById,
  listFeaturesByDestination,
  searchDestinations
} from '../db/destinationRepo.js'
import { detectInjection, wrapUntrusted } from './sanitize.js'
import { buildCacheKey, getCached, setCached } from './webSearchCache.js'


// Task 3.5 + 3.7:工具返回的 source(union,跟 ag-ui.ts:Source 对齐)
// destination:SQL 工具命中的目的地
// url:web_search 命中的 URL
import type { DestinationSource, UrlSource } from './ag-ui.js'
export type ToolSource = DestinationSource | UrlSource

export type ToolRunResult = {
  text: string
  referencedDestinationIds: number[]
  // Task 3.5:工具调用引用过的目的地来源,langgraph-agent.ts 聚合后挂到 RUN_FINISHED.sources
  sources?: ToolSource[]
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

  // Task 3.7:Tavily 联网搜索工具,突破"只覆盖 3 个目的地"的限制
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description:
        '通过联网搜索回答**实时信息**(开园时间、活动、价格、当前天气、新闻等)或**数据库未覆盖的目的地**(目前数据库只有成都/丽江/哈尔滨,其他城市都需要 web_search)。返回 url + title + snippet 列表。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索查询,推荐使用准确的中文表达' },
          max_results: { type: 'integer', description: '返回结果上限', default: 5 },
          search_depth: {
            type: 'string',
            enum: ['basic', 'advanced'],
            description: 'basic 快、advanced 更深(默认 basic)'
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
  | { name: 'web_search'; args: { query: string; max_results?: number; search_depth?: 'basic' | 'advanced' } }

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
  if (name === 'web_search') {
    const depth = j.search_depth != null ? String(j.search_depth) : 'basic'
    return {
      name,
      args: {
        query: String(j.query ?? ''),
        max_results: j.max_results != null ? Number(j.max_results) : 5,
        search_depth: depth === 'advanced' ? 'advanced' : 'basic'
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
        type: 'destination' as const,
        destinationId: r.id,
        destinationName: r.name,
        region: r.region,
        via: 'search_destinations' as const
      }))
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
        type: 'destination' as const,
        destinationId: dest.id,
        destinationName: dest.name,
        region: dest.region,
        via: 'get_destination_detail' as const
      }]
    }
  }
  if (parsed.name === 'web_search') {
    return runWebSearch(pool, config, parsed.args)
  }
  throw new Error(`unknown tool: ${name}`)
}

// ─── Task 3.7:web_search 实现 ───────────────────────────────────

type TavilyResult = {
  url: string
  title: string
  content: string
  score?: number
}

type TavilyResponse = {
  query: string
  results: TavilyResult[]
  answer?: string
}

async function runWebSearch(
  pool: DbPool,
  config: AppConfig,
  args: { query: string; max_results?: number; search_depth?: 'basic' | 'advanced' }
): Promise<ToolRunResult> {
  // 无 key 友好降级:返回明确的"未配置"消息,模型可据此回退到其他工具或如实告知用户
  if (!config.TAVILY_API_KEY) {
    return {
      text: JSON.stringify({
        error: 'TAVILY_API_KEY 未配置,联网搜索不可用。请改用 search_destinations,或如实告知用户"目前无法联网查实时信息"。'
      }),
      referencedDestinationIds: [],
      sources: []
    }
  }

  const maxResults = Math.min(Math.max(args.max_results ?? 5, 1), 10)
  const depth: 'basic' | 'advanced' = args.search_depth ?? 'basic'
  const cacheKey = buildCacheKey(args.query, depth)

  // 缓存优先(TTL 24h 默认)
  let response = (await getCached(pool, cacheKey, config.WEB_SEARCH_CACHE_TTL_SECONDS)) as TavilyResponse | null
  if (!response) {
    const { tavily } = await import('@tavily/core')
    const client = tavily({ apiKey: config.TAVILY_API_KEY })
    try {
      response = (await client.search(args.query, {
        maxResults,
        searchDepth: depth
      })) as TavilyResponse
      await setCached(pool, cacheKey, response).catch(() => {
        /* 缓存写失败不阻塞主流程 */
      })
    } catch (err) {
      return {
        text: JSON.stringify({ error: `web_search failed: ${String(err)}` }),
        referencedDestinationIds: [],
        sources: []
      }
    }
  }

  // 间接注入防御:每条 snippet 走 detectInjection,命中则用 <untrusted_user_content> 包裹
  // (网页是高危源,这是阶段2 §5.6 + Task 3.3 的伏笔正式生效之处)
  const results = response.results.slice(0, maxResults)
  const safeResults = results.map((r) => {
    const text = r.content || r.title
    const inj = detectInjection(text)
    return {
      url: r.url,
      title: r.title,
      snippet: inj.matched ? wrapUntrusted(text) : text,
      injectionDetected: inj.matched ? inj.severity : undefined
    }
  })

  const sources: ToolSource[] = results.map((r) => ({
    type: 'url' as const,
    url: r.url,
    title: r.title,
    snippet: r.content?.slice(0, 200),
    via: 'web_search' as const
  }))

  return {
    text: JSON.stringify({
      query: args.query,
      answer: response.answer,
      results: safeResults
    }),
    referencedDestinationIds: [],
    sources
  }
}
