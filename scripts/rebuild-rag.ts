import 'dotenv/config'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db/pool.js'
import { truncateRagChunks, insertRagChunk } from '../src/db/ragRepo.js'
import { buildChunkPayloads } from '../src/rag/ingest.js'
import { embedTexts } from '../src/rag/embed.js'

const BATCH = 16

async function main() {
  const config = loadConfig()
  const pool = createPool(config)
  const payloads = await buildChunkPayloads(pool)
  await truncateRagChunks(pool)
  for (let i = 0; i < payloads.length; i += BATCH) {
    const batch = payloads.slice(i, i + BATCH)
    const texts = batch.map((p) => p.chunk_text)
    const vectors = await embedTexts(config, texts)
    for (let j = 0; j < batch.length; j++) {
      const p = batch[j]
      const emb = vectors[j]
      await insertRagChunk(pool, {
        destination_id: p.destination_id,
        source: p.source,
        chunk_text: p.chunk_text,
        embedding: emb,
        content_hash: p.content_hash
      })
    }
  }
  await pool.end()
  console.log('RAG rebuild OK, chunks:', payloads.length)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
