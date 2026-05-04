import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import {
  getDestinationById,
  listFeaturesByDestination,
  searchDestinations
} from '../db/destinationRepo.js'


export type ToolRunResult = {
  text: string
  referencedDestinationIds: number[]
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
  }
]

export function getToolDefinitions() {
  return definitions
}

type ToolArgs =
  | { name: 'search_destinations'; args: { query: string; region?: string; limit?: number } }
  | { name: 'get_destination_detail'; args: { destination_id: number } }

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
      referencedDestinationIds: ids
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
      referencedDestinationIds: [dest.id]
    }
  }
  throw new Error(`unknown tool: ${name}`)
}
