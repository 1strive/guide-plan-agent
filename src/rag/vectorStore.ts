/**
 * Task 3.2 — 向量存储接口与 Chroma 实现
 *
 * 规划:docs/开发规划.md Task 3.2(Chroma 替代原 MySQL JSON 列 MVP)
 * 八股:03-RAG技术.md §3 向量化与存储 / §4 检索
 *
 * 设计要点:
 * - VectorStore 是抽象层,业务代码(tools.ts / hybridSearch.ts)只依赖接口;
 *   未来切 Milvus/Qdrant/Pinecone 只换实现,不动业务
 * - ChromaVectorStore 把 Embedder 注入到 Chroma collection 的 embeddingFunction,
 *   add 时不必预先 embed,Chroma 自动调用
 * - cosine 度量:配 metadata['hnsw:space'] = 'cosine'(对齐主流 RAG 实践)
 * - Chroma metadata 是 flat key-value(string/number/bool),所以 ChunkMetadata 展开存
 */

import { ChromaClient, type EmbeddingFunction, type Collection, type Metadata } from 'chromadb'
import type { AppConfig } from '../config.js'
import { createEmbedder, type Embedder } from './embedder.js'
import type { Chunk, ChunkMetadata, SearchResult } from './types.js'

/** 把项目的 Embedder 包装成 chromadb 要求的 EmbeddingFunction */
function asEmbeddingFunction(embedder: Embedder): EmbeddingFunction {
  return {
    name: embedder.name,
    generate: (texts: string[]) => embedder.generate(texts)
  }
}

export interface VectorStore {
  /** 批量写入 chunks(同 id 覆盖) */
  add(chunks: Chunk[]): Promise<void>
  /** 语义检索;filter 走 Chroma where 子句,如 { category: 'food' } */
  query(text: string, topK: number, filter?: Record<string, unknown>): Promise<SearchResult[]>
  /** 当前 collection 总条数,用于灌数据后校验 */
  count(): Promise<number>
  /** 清空 collection(灌数据脚本用,避免脏数据) */
  reset(): Promise<void>
}

class ChromaVectorStore implements VectorStore {
  private collection: Collection | null = null

  constructor(
    private client: ChromaClient,
    private collectionName: string,
    private embedder: Embedder
  ) {}

  private async ensureCollection(): Promise<Collection> {
    if (this.collection) return this.collection
    this.collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
      embeddingFunction: asEmbeddingFunction(this.embedder),
      // metadata 是 collection 级别的标记,便于跨次跑批时识别 embedder 是否变了
      metadata: {
        'hnsw:space': 'cosine',
        embedder_name: this.embedder.name,
        embedder_dim: this.embedder.dim
      }
    })
    return this.collection
  }

  async add(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return
    const col = await this.ensureCollection()
    // ChunkMetadata 展开为 flat Metadata(Chroma 不支持嵌套对象)
    const metadatas: Metadata[] = chunks.map((c) => ({
      destinationId: c.metadata.destinationId,
      destinationName: c.metadata.destinationName,
      region: c.metadata.region,
      category: c.metadata.category,
      source: c.metadata.source
    }))
    await col.add({
      ids: chunks.map((c) => c.id),
      documents: chunks.map((c) => c.text),
      metadatas
    })
  }

  async query(
    text: string,
    topK: number,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]> {
    const col = await this.ensureCollection()
    const result = await col.query({
      queryTexts: [text],
      nResults: topK,
      // Chroma Where 类型严格,我们只传简单 key-value(运行期校验由 Chroma 兜底)
      where: filter as never
    })
    const ids = result.ids?.[0] ?? []
    const docs = result.documents?.[0] ?? []
    const metas = result.metadatas?.[0] ?? []
    const dists = result.distances?.[0] ?? []
    return ids.map((id, i) => ({
      id,
      text: docs[i] ?? '',
      metadata: metas[i] as unknown as ChunkMetadata,
      distance: dists[i] ?? 0
    }))
  }

  async count(): Promise<number> {
    const col = await this.ensureCollection()
    return col.count()
  }

  async reset(): Promise<void> {
    try {
      await this.client.deleteCollection({ name: this.collectionName })
    } catch {
      // collection 不存在等情况静默跳过
    }
    this.collection = null
  }
}

export function createVectorStore(config: AppConfig): VectorStore {
  const url = new URL(config.CHROMA_URL)
  const client = new ChromaClient({
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    ssl: url.protocol === 'https:'
  })
  const embedder = createEmbedder(config)
  return new ChromaVectorStore(client, config.CHROMA_COLLECTION, embedder)
}
