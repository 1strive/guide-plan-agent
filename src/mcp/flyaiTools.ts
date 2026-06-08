/**
 * FlyAI(飞猪)旅行搜索工具 — 把 flyai CLI 包装成 LangChain StructuredTool
 *
 * 飞猪官方推出的 Travel Skill,数据源覆盖国内机票/火车票/酒店/景点/邮轮/签证等。
 * GitHub: https://github.com/alibaba-flyai/flyai-skill
 * CLI: @fly-ai/flyai-cli (npm i -g @fly-ai/flyai-cli)
 *
 * 接入方式:flyai CLI 不是 MCP Server,而是标准命令行工具;
 * 这里用 child_process.execFile 调用,把 JSON stdout 返回给 LLM。
 */

import { tool } from '@langchain/core/tools'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { StructuredToolInterface } from '@langchain/core/tools'

const exec = promisify(execFile)

const FLYAI_TIMEOUT = 30_000

async function runFlyai(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await exec('flyai', args, { timeout: FLYAI_TIMEOUT })
    if (stderr && !stdout) return JSON.stringify({ error: stderr.trim() })
    return stdout.trim() || JSON.stringify({ error: 'no output' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return JSON.stringify({ error: `flyai command failed: ${msg}` })
  }
}

const searchFlight = tool(
  async (input) => {
    const args = ['search-flight', '--origin', input.origin, '--destination', input.destination, '--dep-date', input.depDate]
    if (input.backDate) args.push('--back-date', input.backDate)
    if (input.journeyType) args.push('--journey-type', input.journeyType)
    if (input.seatClassName) args.push('--seat-class-name', input.seatClassName)
    if (input.maxPrice) args.push('--max-price', String(input.maxPrice))
    if (input.sortType) args.push('--sort-type', String(input.sortType))
    return runFlyai(args)
  },
  {
    name: 'flyai_search_flight',
    description: '搜索机票(飞猪数据源,覆盖国内国际航班)。支持单程/往返、舱位筛选、价格上限、排序。返回航班列表含价格和预订链接。',
    schema: z.object({
      origin: z.string().describe('出发城市(如"北京""上海")'),
      destination: z.string().describe('目的地城市'),
      depDate: z.string().describe('出发日期 YYYY-MM-DD'),
      backDate: z.string().optional().describe('回程日期 YYYY-MM-DD(往返时填)'),
      journeyType: z.enum(['1', '2']).optional().describe('1=直达 2=中转'),
      seatClassName: z.string().optional().describe('舱位:economy/business/first'),
      maxPrice: z.number().optional().describe('最高价(元)'),
      sortType: z.enum(['1', '2', '3', '4', '5', '6', '7', '8']).optional()
        .describe('排序:2=推荐 3=价格低→高 6=出发早→晚 8=直达优先')
    })
  }
)

const searchTrain = tool(
  async (input) => {
    const args = ['search-train', '--origin', input.origin, '--destination', input.destination]
    if (input.depDate) args.push('--dep-date', input.depDate)
    return runFlyai(args)
  },
  {
    name: 'flyai_search_train',
    description: '搜索火车票(飞猪数据源,覆盖高铁/动车/普通列车)。返回车次列表含价格和时刻。',
    schema: z.object({
      origin: z.string().describe('出发城市'),
      destination: z.string().describe('目的地城市'),
      depDate: z.string().optional().describe('出发日期 YYYY-MM-DD')
    })
  }
)

const searchHotel = tool(
  async (input) => {
    const args = ['search-hotel', '--dest-name', input.destName]
    if (input.keyWords) args.push('--key-words', input.keyWords)
    if (input.poiName) args.push('--poi-name', input.poiName)
    if (input.checkInDate) args.push('--check-in-date', input.checkInDate)
    if (input.checkOutDate) args.push('--check-out-date', input.checkOutDate)
    if (input.hotelStars) args.push('--hotel-stars', input.hotelStars)
    if (input.maxPrice) args.push('--max-price', String(input.maxPrice))
    if (input.sort) args.push('--sort', input.sort)
    return runFlyai(args)
  },
  {
    name: 'flyai_search_hotel',
    description: '搜索酒店(飞猪数据源,覆盖国内酒店/民宿/客栈)。支持按景点附近、星级、价格筛选。返回酒店列表含价格和预订链接。',
    schema: z.object({
      destName: z.string().describe('目的地(城市/区/省,如"杭州""西湖区")'),
      keyWords: z.string().optional().describe('关键词(如"亲子""温泉")'),
      poiName: z.string().optional().describe('附近景点名(如"西湖""故宫")'),
      checkInDate: z.string().optional().describe('入住日期 YYYY-MM-DD'),
      checkOutDate: z.string().optional().describe('退房日期 YYYY-MM-DD'),
      hotelStars: z.string().optional().describe('星级 1-5,逗号分隔(如"4,5")'),
      maxPrice: z.number().optional().describe('最高价(元/晚)'),
      sort: z.enum(['distance_asc', 'rate_desc', 'price_asc', 'price_desc', 'no_rank']).optional()
        .describe('排序:rate_desc=评分高→低 price_asc=价格低→高')
    })
  }
)

const searchPoi = tool(
  async (input) => {
    const args = ['search-poi', '--city-name', input.cityName]
    return runFlyai(args)
  },
  {
    name: 'flyai_search_poi',
    description: '搜索景点/门票(飞猪数据源)。返回景点列表含门票价格和预订链接。',
    schema: z.object({
      cityName: z.string().describe('城市名(如"北京""杭州")')
    })
  }
)

const aiSearch = tool(
  async (input) => {
    return runFlyai(['ai-search', '--query', input.query])
  },
  {
    name: 'flyai_ai_search',
    description: '飞猪 AI 语义搜索 — 用自然语言描述复杂旅行需求(如"五一杭州3天2000预算住西湖附近"),返回综合匹配结果(酒店+机票+景点混合)。适合用户需求复杂或跨品类时使用。',
    schema: z.object({
      query: z.string().describe('完整的自然语言旅行需求描述')
    })
  }
)

export function createFlyaiTools(): StructuredToolInterface[] {
  return [
    searchFlight as unknown as StructuredToolInterface,
    searchTrain as unknown as StructuredToolInterface,
    searchHotel as unknown as StructuredToolInterface,
    searchPoi as unknown as StructuredToolInterface,
    aiSearch as unknown as StructuredToolInterface
  ]
}
