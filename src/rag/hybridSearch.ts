/**
 * Task 3.4 — 混合检索 + 重排序
 *
 * 规划:docs/开发规划.md Task 3.4(关键词 + 语义 RRF 融合 + 简易 rerank)
 * 八股:03-RAG技术.md §5 混合检索 / §6 重排序
 *
 * 设计要点:
 * - RRF (Reciprocal Rank Fusion):score = Σ 1/(k + rank_i),k 工业默认 60
 *   优点:无需归一化不同检索器的分数尺度,稳定性强;
 *   适合"关键词 BM25/LIKE 分数"与"向量距离"这种不同量纲组合
 * - 输入:keyword Top-N + semantic Top-N(N 通常 = 2 * topK,给融合留余地)
 * - 输出:融合排序后的 Top-K(以 destinationId 去重,同一目的地多 chunk 取最高分代表)
 * - rerank:用查询词字符 n-gram 与候选文本重合度做二次排序;轻量,无外部依赖
 *   (生产建议接 cross-encoder reranker,如 bge-reranker-base,此处出于零依赖原则降级)
 */

import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import { searchDestinations, type DestinationRow } from '../db/destinationRepo.js'
import { createVectorStore } from './vectorStore.js'
import type { SearchResult } from './types.js'

export type HybridResult = {
  destinationId: number
  destinationName: string
  region: string
  // 召回理由便于评测/溯源审计
  reasons: Array<'keyword' | 'semantic'>
  // 融合后的最终分(越大越好)
  score: number
  // 代表性文本(从命中的 chunk 中选距离最近的)
  representativeText: string
}

const RRF_K = 60

/** 关键词检索 → 转成"伪 chunk"列表(用于和向量结果统一格式) */
async function keywordSearch(
  pool: DbPool,
  query: string,
  limit: number
): Promise<DestinationRow[]> {
  return searchDestinations(pool, { query, limit })
}

/**
 * RRF 融合两个排好序的结果列表。
 * @param keywordHits 按相关性降序排列(我们简化为 SQL 返回顺序)
 * @param semanticHits 按向量距离升序(Chroma 默认返回顺序)
 */
function rrfFuse(
  keywordHits: DestinationRow[],
  semanticHits: SearchResult[]
): Map<number, { score: number; reasons: Set<'keyword' | 'semantic'>; bestText: string; name: string; region: string }> {
  const bag = new Map<number, { score: number; reasons: Set<'keyword' | 'semantic'>; bestText: string; name: string; region: string }>()

  keywordHits.forEach((d, rank) => {
    const entry = bag.get(d.id) ?? { score: 0, reasons: new Set(), bestText: d.summary, name: d.name, region: d.region }
    entry.score += 1 / (RRF_K + rank)
    entry.reasons.add('keyword')
    bag.set(d.id, entry)
  })

  semanticHits.forEach((s, rank) => {
    const id = s.metadata.destinationId
    const entry = bag.get(id) ?? {
      score: 0,
      reasons: new Set(),
      bestText: s.text,
      name: s.metadata.destinationName,
      region: s.metadata.region
    }
    entry.score += 1 / (RRF_K + rank)
    entry.reasons.add('semantic')
    // 取距离最近的语义 chunk 作为代表文本(更贴合 query)
    if (rank === 0 || entry.bestText.length < s.text.length) {
      entry.bestText = s.text
    }
    bag.set(id, entry)
  })

  return bag
}

/**
 * 简易 rerank:用 query 字符 2-gram 与候选文本重合数作二次分,跟 RRF 分线性加权。
 * 计算成本 O(query_len * candidates) 很小;生产可换 cross-encoder。
 */
function lexicalOverlapBoost(query: string, text: string): number {
  const grams = (s: string): Set<string> => {
    const out = new Set<string>()
    const chars = Array.from(s.toLowerCase().replace(/\s+/g, ''))
    for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1])
    return out
  }
  const qg = grams(query)
  const tg = grams(text)
  let hit = 0
  for (const g of qg) if (tg.has(g)) hit++
  return qg.size > 0 ? hit / qg.size : 0
}

export type HybridStrategy = 'keyword' | 'semantic' | 'hybrid'

/**
 * 统一检索入口:三种策略对外接口一致,便于评测脚本切换对比
 *
 * @param strategy keyword=仅 SQL LIKE / semantic=仅向量 / hybrid=RRF 融合 + lexical rerank
 * @param topK 返回去重后的目的地条数
 * @param recallN 每路召回数(hybrid 时建议 = 2 * topK)
 */
export async function hybridSearchTravel(
  pool: DbPool,
  config: AppConfig,
  query: string,
  strategy: HybridStrategy = 'hybrid',
  topK = 5,
  recallN = 10
): Promise<HybridResult[]> {
  // ── 单路:仅关键词 ──
  if (strategy === 'keyword') {
    const rows = await keywordSearch(pool, query, topK)
    return rows.map((d) => ({
      destinationId: d.id,
      destinationName: d.name,
      region: d.region,
      reasons: ['keyword'],
      score: 1,
      representativeText: d.summary
    }))
  }

  // ── 单路:仅语义 ──
  if (strategy === 'semantic') {
    const vs = createVectorStore(config)
    const sems = await vs.query(query, topK)
    return sems.map((s) => ({
      destinationId: s.metadata.destinationId,
      destinationName: s.metadata.destinationName,
      region: s.metadata.region,
      reasons: ['semantic'],
      score: 1 - s.distance,
      representativeText: s.text
    }))
  }

  // ── 混合:RRF 融合 + lexical rerank ──
  const [keywordHits, vs] = await Promise.all([
    keywordSearch(pool, query, recallN),
    Promise.resolve(createVectorStore(config))
  ])
  const semanticHits = await vs.query(query, recallN)

  const fused = rrfFuse(keywordHits, semanticHits)
  const ranked: HybridResult[] = Array.from(fused.entries()).map(([id, e]) => ({
    destinationId: id,
    destinationName: e.name,
    region: e.region,
    reasons: Array.from(e.reasons),
    // RRF 分 + lexical overlap rerank(权重 0.3 实测可调)
    score: e.score + 0.3 * lexicalOverlapBoost(query, e.bestText),
    representativeText: e.bestText
  }))

  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, topK)
}
