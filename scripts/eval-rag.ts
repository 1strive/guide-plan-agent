/**
 * Task 3.4 — RAG 检索策略对比脚本
 *
 * 用法:
 *   npm run eval:rag                    # 跑全部 query × 3 种策略
 *
 * 输出:
 *   - 控制台:每 query 的 Top-K 命中表(含 reasons + score)
 *   - docs/02-实验记录/exp-04-hybrid-vs-pure-{ts}.json:原始数据
 *
 * 限制:
 *   - 当前 EMBEDDING_PROVIDER=deterministic,semantic/hybrid 召回质量不代表真生产
 *   - 评测的是"召回机制本身是否工作 + 三种策略路径都通",换真 embedder 后再看真实质量
 */

import { config as loadDotenv } from 'dotenv'
loadDotenv()
loadDotenv({ path: '.env.local', override: true })

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db/pool.js'
import { hybridSearchTravel, type HybridStrategy, type HybridResult } from '../src/rag/hybridSearch.js'

type EvalQuery = {
  id: string
  query: string
  // 期望命中的 destinationName 列表(任一命中即算"召回正确");null 表示无标准答案,仅看路径通不通
  expected: string[] | null
}

const QUERIES: EvalQuery[] = [
  { id: 'q1', query: '想看雪山但不想太累', expected: ['丽江'] },
  { id: 'q2', query: '推荐一个吃辣的地方', expected: ['成都'] },
  { id: 'q3', query: '冬季冰雪体验', expected: ['哈尔滨'] },
  { id: 'q4', query: '亲子游适合的城市', expected: ['成都'] },
  { id: 'q5', query: '古城慢节奏', expected: ['丽江'] },
  { id: 'q6', query: '欧式风情', expected: ['哈尔滨'] }
]

const STRATEGIES: HybridStrategy[] = ['keyword', 'semantic', 'hybrid']
const TOP_K = 3

type StrategyResult = {
  strategy: HybridStrategy
  hits: HybridResult[]
  // top-1 是否命中 expected(召回准确率简化指标)
  top1Hit: boolean | null
  // top-K 内是否命中
  topKHit: boolean | null
}

async function main(): Promise<void> {
  const config = loadConfig()
  const pool = createPool(config)
  console.log(`[eval-rag] embedder=${config.EMBEDDING_PROVIDER} queries=${QUERIES.length} strategies=${STRATEGIES.join(',')} topK=${TOP_K}`)

  const allResults: Array<{ queryId: string; query: string; expected: string[] | null; runs: StrategyResult[] }> = []

  for (const q of QUERIES) {
    console.log(`\n── ${q.id}: "${q.query}" (期望: ${q.expected?.join('/') ?? '无'}) ──`)
    const runs: StrategyResult[] = []
    for (const strategy of STRATEGIES) {
      const hits = await hybridSearchTravel(pool, config, q.query, strategy, TOP_K, TOP_K * 2)
      const top1Hit = q.expected ? hits[0] != null && q.expected.includes(hits[0].destinationName) : null
      const topKHit = q.expected ? hits.some((h) => q.expected!.includes(h.destinationName)) : null
      runs.push({ strategy, hits, top1Hit, topKHit })

      const tag = top1Hit === true ? '✓' : top1Hit === false ? '✗' : '-'
      const names = hits.map((h) => `${h.destinationName}[${h.reasons.join('+')}/${h.score.toFixed(3)}]`).join(' ')
      console.log(`  ${tag} ${strategy.padEnd(8)} → ${names || '(no result)'}`)
    }
    allResults.push({ queryId: q.id, query: q.query, expected: q.expected, runs })
  }

  // ── 汇总 ──
  console.log('\n=== Top-1 召回率(命中数 / 有期望的 query 数)===')
  for (const strategy of STRATEGIES) {
    const eligible = allResults.filter((r) => r.expected !== null)
    const hits = eligible.filter((r) => r.runs.find((x) => x.strategy === strategy)?.top1Hit).length
    const rate = eligible.length > 0 ? (hits / eligible.length) * 100 : 0
    console.log(`  ${strategy.padEnd(8)} ${hits}/${eligible.length} (${rate.toFixed(1)}%)`)
  }

  console.log('\n=== Top-K 召回率(命中数 / 有期望的 query 数)===')
  for (const strategy of STRATEGIES) {
    const eligible = allResults.filter((r) => r.expected !== null)
    const hits = eligible.filter((r) => r.runs.find((x) => x.strategy === strategy)?.topKHit).length
    const rate = eligible.length > 0 ? (hits / eligible.length) * 100 : 0
    console.log(`  ${strategy.padEnd(8)} ${hits}/${eligible.length} (${rate.toFixed(1)}%)`)
  }

  // ── JSON 报告 ──
  const outDir = path.resolve('docs/02-实验记录')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(outDir, `exp-04-hybrid-vs-pure-${ts}.json`)
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        embedder: config.EMBEDDING_PROVIDER,
        embedderDim: config.EMBEDDING_DIM,
        topK: TOP_K,
        results: allResults
      },
      null,
      2
    ),
    'utf-8'
  )
  console.log(`\nreport: ${outFile}`)

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
