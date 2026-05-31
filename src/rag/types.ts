/**
 * Task 3.1 — RAG 通用类型
 *
 * 规划:docs/开发规划.md Task 3.1(切分与 embedding) / 3.2(向量存储)
 * 八股:03-RAG技术.md §2 切分策略 / §3 向量化与存储
 *
 * 设计原则:
 * - Chunk 是 RAG 流水线的最小流通单元,同时携带 text(给模型读)+ metadata(给检索过滤)
 * - 不在类型层强约束 metadata 字段,让不同切分策略自由扩展
 */

export type ChunkCategory = 'summary' | 'food' | 'scenery' | 'culture'

export type ChunkMetadata = {
  destinationId: number
  destinationName: string
  region: string
  category: ChunkCategory
  // 来源标识:summary 来自 destinations.summary,feature 来自 destination_features.*
  source: 'summary' | 'feature'
}

export type Chunk = {
  // 全局唯一 id;格式:dest{destId}-{category}-{seq};入 Chroma 时直接做主键
  id: string
  text: string
  metadata: ChunkMetadata
}

export type SearchResult = {
  id: string
  text: string
  metadata: ChunkMetadata
  // cosine 距离(0~2,越小越相似);Chroma 原生返回的就是距离不是相似度
  distance: number
}
