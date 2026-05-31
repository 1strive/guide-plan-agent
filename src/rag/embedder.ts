/**
 * Task 3.1 — Embedding 抽象与多 provider 实现
 *
 * 规划:docs/开发规划.md Task 3.1
 * 八股:03-RAG技术.md §3.1 embedding 模型选型 / 08-工程化实践.md §5 多 provider 抽象
 *
 * 设计要点:
 * - Embedder 接口约定 generate(texts) → number[][],对齐 chromadb 的 EmbeddingFunction.generate
 *   (这样可以直接当 Chroma collection 的 embeddingFunction 用,见 vectorStore.ts)
 * - 三个实现:
 *   • MinimaxEmbedder:走 embo-01,需 token plan 支持(当前测试账号不支持,会 throw)
 *   • OpenAIEmbedder:走 /embeddings 标准协议(text-embedding-3-small),需真 OpenAI key
 *   • DeterministicEmbedder:字符 n-gram 哈希向量,完全离线;dev/演示用
 *     语义相似度有限,但相同/相似文本会有更高 cosine,足以验证 Chroma 索引行为
 * - 选择由 config.EMBEDDING_PROVIDER 控制,工厂函数 createEmbedder 统一构造
 */

import type { AppConfig } from '../config.js'

/** 与 chromadb 的 EmbeddingFunction 接口约定一致 */
export interface Embedder {
  /** 模型/维度标识,写到 Chroma metadata 便于切换时区分 */
  readonly name: string
  readonly dim: number
  generate(texts: string[]): Promise<number[][]>
}

// ── MiniMax embo-01 ──────────────────────────────────────────────
class MinimaxEmbedder implements Embedder {
  readonly name = 'minimax/embo-01'
  readonly dim = 1536
  constructor(private baseUrl: string, private apiKey: string) {}

  async generate(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      // MiniMax 自有协议:texts 而非 input;type='db' 入库 / 'query' 查询
      body: JSON.stringify({ texts, model: 'embo-01', type: 'db' })
    })
    if (!res.ok) throw new Error(`minimax embedding ${res.status}: ${await res.text()}`)
    const data = await res.json() as { vectors?: number[][]; base_resp?: { status_code: number; status_msg: string } }
    if (!data.vectors) {
      throw new Error(`minimax embedding failed: ${data.base_resp?.status_msg ?? 'unknown'}`)
    }
    return data.vectors
  }
}

// ── OpenAI 标准协议 ──────────────────────────────────────────────
class OpenAIEmbedder implements Embedder {
  readonly name: string
  readonly dim = 1536
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string
  ) {
    this.name = `openai/${model}`
  }

  async generate(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ input: texts, model: this.model })
    })
    if (!res.ok) throw new Error(`openai embedding ${res.status}: ${await res.text()}`)
    const data = await res.json() as { data?: Array<{ embedding: number[] }> }
    if (!data.data) throw new Error('openai embedding: missing data')
    return data.data.map((d) => d.embedding)
  }
}

// ── Deterministic(离线 fallback)──────────────────────────────────
//
// 算法:
// 1. 对每段文本提取所有字符 2-gram + 3-gram
// 2. 每个 n-gram FNV-1a 哈希到 [0, dim) 的某一维,该维 +1
// 3. L2 归一化向量
// 性质:
// - 完全 deterministic、无依赖
// - 相同文本 → 相同向量;相似文本(共享 n-gram 多)→ cosine 较高
// - 不能捕捉真正的语义("好玩"和"有趣"几乎不相似),但流程能跑、Chroma 能演示
class DeterministicEmbedder implements Embedder {
  readonly name: string
  constructor(readonly dim: number) {
    this.name = `deterministic/${dim}d`
  }

  async generate(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embed(t))
  }

  private embed(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0)
    const grams = this.charNgrams(text, 2).concat(this.charNgrams(text, 3))
    for (const g of grams) {
      vec[this.hash(g) % this.dim] += 1
    }
    // L2 归一化(让 cosine 直接等于内积)
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
    return vec.map((v) => v / norm)
  }

  private charNgrams(text: string, n: number): string[] {
    const chars = Array.from(text.toLowerCase().replace(/\s+/g, ''))
    if (chars.length < n) return chars.length > 0 ? [chars.join('')] : []
    const out: string[] = []
    for (let i = 0; i <= chars.length - n; i++) out.push(chars.slice(i, i + n).join(''))
    return out
  }

  // FNV-1a 32bit;为减小冲突,先把每个 char 当 codepoint 累乘
  private hash(s: string): number {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h >>> 0
  }
}

// ── 工厂 ──────────────────────────────────────────────────────────
export function createEmbedder(config: AppConfig): Embedder {
  switch (config.EMBEDDING_PROVIDER) {
    case 'minimax':
      return new MinimaxEmbedder(config.OPENAI_BASE_URL, config.OPENAI_API_KEY)
    case 'openai':
      return new OpenAIEmbedder(
        config.OPENAI_BASE_URL,
        config.OPENAI_API_KEY,
        process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small'
      )
    case 'deterministic':
      return new DeterministicEmbedder(config.EMBEDDING_DIM)
  }
}
