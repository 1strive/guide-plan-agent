/**
 * Task 3.2 — 灌向量数据脚本
 *
 * 用法:
 *   npm run index           # 全量 reset + 重灌
 *   npx tsx scripts/index-vectors.ts --no-reset   # 增量(谨慎,会有重复 id 冲突)
 *
 * 规划:docs/开发规划.md Task 3.2(灌数据 + Top-K 示例)
 *
 * 流程:
 *   1. 从 MySQL 取 destinations + destination_features
 *   2. chunker.buildAllChunks 生成 Chunk[]
 *   3. vectorStore.reset() 清旧 collection(避免 embedder 切换后维度冲突)
 *   4. vectorStore.add(chunks) 触发 EmbeddingFunction 自动生成向量并入库
 *   5. count() 校验 + 跑 3 条 query 看 Top-3 结果
 */

import { config as loadDotenv } from 'dotenv'
loadDotenv()
loadDotenv({ path: '.env.local', override: true })

import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db/pool.js'
import { buildAllChunks } from '../src/rag/chunker.js'
import { createVectorStore } from '../src/rag/vectorStore.js'

async function main(): Promise<void> {
  const noReset = process.argv.includes('--no-reset')
  const config = loadConfig()
  const pool = createPool(config)
  const store = createVectorStore(config)

  console.log(`[index] embedder=${config.EMBEDDING_PROVIDER} chroma=${config.CHROMA_URL} collection=${config.CHROMA_COLLECTION}`)

  console.log('[index] building chunks from DB...')
  const chunks = await buildAllChunks(pool)
  console.log(`[index] built ${chunks.length} chunks`)

  if (!noReset) {
    console.log('[index] resetting collection (drop & recreate)...')
    await store.reset()
  }

  console.log('[index] adding to Chroma (auto-embed via EmbeddingFunction)...')
  const startedAt = Date.now()
  await store.add(chunks)
  console.log(`[index] added in ${Date.now() - startedAt}ms`)

  const count = await store.count()
  console.log(`[index] collection now has ${count} vectors`)

  // ── 烟测 3 条 query,看 Top-3 结果 ──
  const smokeQueries = ['想去看雪山,不要太累', '推荐一个吃辣的地方', '冬季旅游有什么选择']
  console.log('\n[smoke] Top-3 results per query:')
  for (const q of smokeQueries) {
    const results = await store.query(q, 3)
    console.log(`\nQ: ${q}`)
    for (const r of results) {
      console.log(`  [${r.distance.toFixed(4)}] ${r.id} | ${r.metadata.destinationName} | ${r.text.slice(0, 60)}...`)
    }
  }

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
