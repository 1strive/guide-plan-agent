# 阶段3 开发笔记:RAG 接入(代码改动速查)

> **本文目标**:把 `docs/开发规划.md` 阶段3 Task 3.1~3.5 落地的**每一处代码改动**记录清楚,方便下次接手 / 回看 / 排错时直接跳到对应文件,不用逆向猜实现。
>
> 不讲原理(原理见 `docs/01-面试八股文/03-RAG技术.md`),不讲 STAR 故事(参见 `docs/02-实验记录/exp-04-hybrid-vs-pure.md`),只列"做了什么、改了哪、为什么"。
>
> **配套文档**:架构总图 `docs/04-架构文档/agent-架构.md §1.1 / §3.6 / §4.4 / §5.7~§5.8`;混合检索实测 `docs/02-实验记录/exp-04`。

---

## 总览

| Task | 一句话 | 新增文件 | 改动文件 |
|------|--------|----------|---------|
| 3.1 | 切分 + Embedder 抽象 + deterministic fallback | `src/rag/types.ts` `src/rag/chunker.ts` `src/rag/embedder.ts` | `src/config.ts` `.env` |
| 3.2 | Chroma 向量库 + VectorStore 抽象 + 灌数据脚本 | `src/rag/vectorStore.ts` `scripts/index-vectors.ts` | `docker-compose.yml` `src/config.ts` `package.json` `.env` |
| 3.3 | `semantic_search_travel` 工具(LLM 入口) | — | `src/agent/tools.ts` `src/eval/testset.ts` |
| 3.4 | 混合检索 RRF + lexical rerank + 评测脚本 | `src/rag/hybridSearch.ts` `scripts/eval-rag.ts` | `package.json` |
| 3.5 | 溯源 sources 字段贯通 | — | `src/agent/ag-ui.ts` `src/agent/tools.ts` `src/agent/llm.ts` `src/agent/prompts/v1_base.ts` |

数据规模:18 chunks(3 个目的地 × {1 summary + 5 features});当前 embedder 走 `deterministic`(128 维),Task 3.6 后切 Xenova ONNX(512 维)。

---

## Task 3.1:切分 + Embedder 抽象

### 新增 `src/rag/types.ts`

定义 RAG 流水线的最小流通单元:

```ts
export type ChunkCategory = 'summary' | 'food' | 'scenery' | 'culture'

export type ChunkMetadata = {
  destinationId: number
  destinationName: string
  region: string
  category: ChunkCategory
  source: 'summary' | 'feature'
}

export type Chunk = { id: string; text: string; metadata: ChunkMetadata }
export type SearchResult = Chunk & { distance: number }
```

### 新增 `src/rag/chunker.ts`

`buildAllChunks(pool)` 从 MySQL 读两张表,生成 18 chunks:

```ts
// summary chunks
for (const d of destRows) chunks.push({
  id: `dest${d.id}-summary-0`,
  text: `${d.name}(${d.region}):${d.summary}`,   // 自带"目的地名"前缀
  metadata: { ...d, category: 'summary', source: 'summary' }
})

// feature chunks
for (const f of featRows) chunks.push({
  id: `dest${f.destination_id}-${f.category}-${f.id}`,
  text: `${f.dest_name}的${categoryLabel(f.category)}「${f.title}」:${f.description}`,
  metadata: { ...f, source: 'feature' }
})
```

**两个设计点**:
- 不做 overlap(条目独立,overlap 引入噪声)
- chunk text 拼前缀("丽江的美景「玉龙雪山」:...")让 chunk 自我描述,模型只看一条也能定位

### 新增 `src/rag/embedder.ts`

接口 + 工厂 + 3 个实现:

```ts
export interface Embedder {
  readonly name: string
  readonly dim: number
  generate(texts: string[]): Promise<number[][]>
}

class MinimaxEmbedder implements Embedder { /* embo-01,当前账号无权限 */ }
class OpenAIEmbedder implements Embedder { /* text-embedding-3-small */ }
class DeterministicEmbedder implements Embedder {
  // 字符 2-gram + 3-gram → FNV-1a 哈希 → L2 归一化(128 维,完全离线)
}

export function createEmbedder(config: AppConfig): Embedder {
  switch (config.EMBEDDING_PROVIDER) {
    case 'minimax': return new MinimaxEmbedder(...)
    case 'openai':  return new OpenAIEmbedder(...)
    case 'deterministic': return new DeterministicEmbedder(config.EMBEDDING_DIM)
  }
}
```

**为什么 3 实现而不是 1**:实施时 MiniMax 账号无 embedding 权限,如果硬编码会卡在 RAG 第一步;deterministic 是离线兜底,让流程能跑;真模型在 Task 3.6 接 Xenova。

### 改 `src/config.ts`

加 zod 字段:

```ts
EMBEDDING_PROVIDER: z.enum(['minimax', 'openai', 'deterministic']).default('deterministic'),
EMBEDDING_DIM: z.coerce.number().default(128)
```

### 改 `.env`

```env
EMBEDDING_PROVIDER=deterministic
EMBEDDING_DIM=128
```

---

## Task 3.2:Chroma 向量库

### 改 `docker-compose.yml`

新增 chroma service:

```yaml
chroma:
  image: chromadb/chroma:latest
  ports: ['8000:8000']
  volumes: [chroma_data:/data]
  environment:
    IS_PERSISTENT: 'TRUE'
    PERSIST_DIRECTORY: /data
    ANONYMIZED_TELEMETRY: 'FALSE'
```

启动:`docker compose up -d chroma`。

### 新增 `src/rag/vectorStore.ts`

VectorStore 接口 + Chroma 实现:

```ts
export interface VectorStore {
  add(chunks: Chunk[]): Promise<void>
  query(text: string, topK: number, filter?): Promise<SearchResult[]>
  count(): Promise<number>
  reset(): Promise<void>
}

class ChromaVectorStore implements VectorStore {
  // 关键:把项目的 Embedder 包成 chromadb 要求的 EmbeddingFunction
  private async ensureCollection() {
    this.collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
      embeddingFunction: asEmbeddingFunction(this.embedder),
      metadata: { 'hnsw:space': 'cosine', embedder_name: ..., embedder_dim: ... }
    })
  }
  
  async add(chunks) {
    // 不预算 embedding,Chroma 自动调 embeddingFunction.generate()
    await col.add({ ids, documents, metadatas })
  }
  
  async query(text, topK, filter) {
    const r = await col.query({ queryTexts: [text], nResults: topK, where: filter })
    return ids.map((id, i) => ({ id, text: docs[i], metadata: metas[i], distance: dists[i] }))
  }
}

export function createVectorStore(config: AppConfig): VectorStore {
  const url = new URL(config.CHROMA_URL)
  const client = new ChromaClient({ host: url.hostname, port: Number(url.port), ssl: url.protocol === 'https:' })
  return new ChromaVectorStore(client, config.CHROMA_COLLECTION, createEmbedder(config))
}
```

### 新增 `scripts/index-vectors.ts`

灌数据脚本(`npm run index` 触发):

```ts
1. buildAllChunks(pool)       // MySQL → 18 chunks
2. vectorStore.reset()        // drop 旧 collection(防 embedder 维度切换冲突)
3. vectorStore.add(chunks)    // Chroma 自动算向量入库
4. vectorStore.count()        // 校验 = 18
5. 跑 3 条 smoke query 看 Top-3
```

实测速度:18 chunks × deterministic = ~55ms。

### 改 `src/config.ts`

```ts
CHROMA_URL: z.string().default('http://127.0.0.1:8000'),
CHROMA_COLLECTION: z.string().default('destinations_v1'),
RAG_TOP_K_DEFAULT: z.coerce.number().default(8)
```

### 改 `package.json`

```json
"dependencies": { "chromadb": "^3.4.3", ... }
"scripts": { "index": "tsx scripts/index-vectors.ts", ... }
```

### 改 `.env`

```env
CHROMA_URL=http://127.0.0.1:8000
CHROMA_COLLECTION=destinations_v1
```

### 两层架构原则

```
MySQL (source of truth)  ──npm run index──>  Chroma (索引衍生物,可重建)
```

- 改 seed 必须 `npm run index` 重灌(数据不自动同步)
- Chroma 挂了 / 数据丢了 → 重跑 `npm run index` 完整恢复无业务损失
- 升级 embedder 必须 `vectorStore.reset()` + 重灌(维度变了)

---

## Task 3.3:`semantic_search_travel` 工具

### 改 `src/agent/tools.ts`

**1. import + lazy 单例**:

```ts
import { createVectorStore, type VectorStore } from '../rag/vectorStore.js'
import type { ChunkCategory } from '../rag/types.js'
import { detectInjection, wrapUntrusted } from './sanitize.js'

let _vectorStore: VectorStore | null = null
function getVectorStore(config: AppConfig): VectorStore {
  if (!_vectorStore) _vectorStore = createVectorStore(config)
  return _vectorStore
}
```

**2. `definitions` 数组加第 3 个工具**:

```ts
{
  type: 'function',
  function: {
    name: 'semantic_search_travel',
    description:
      '按自然语言"感觉/偏好/灵感"做向量语义检索(例如「想看雪山又不想太累」)。' +
      '当用户描述模糊或难以用关键词表达时优先使用此工具。',
    parameters: {
      type: 'object',
      properties: {
        query:    { type: 'string' },
        topK:     { type: 'integer', default: 5 },
        category: { type: 'string', enum: ['summary','food','scenery','culture'] }
      },
      required: ['query']
    }
  }
}
```

**3. `ToolArgs` union + `parseArgs` 加分支**(略,样板代码)。

**4. `runTool` 加 `'semantic_search_travel'` 分支**:

```ts
if (parsed.name === 'semantic_search_travel') {
  const topK = Math.min(Math.max(parsed.args.topK ?? 5, 1), 20)
  const filter = parsed.args.category ? { category: parsed.args.category } : undefined
  const results = await getVectorStore(config).query(parsed.args.query, topK, filter)

  // 间接注入防御:RAG 检索内容也是"用户输入"(阶段2 §5.6 留的伏笔)
  const safeChunks = results.map((r) => {
    const inj = detectInjection(r.text)
    return { ...r, text: inj.matched ? wrapUntrusted(r.text) : r.text, ... }
  })

  // 按 destinationId 去重收集 sources
  const sources = ...
  return { text: JSON.stringify({ chunks: safeChunks }), referencedDestinationIds, sources }
}
```

### 改 `src/eval/testset.ts`

把 `sem-01` 从 `knownFail` 转入硬性评估:

```ts
{
  id: 'sem-01',
  category: 'semantic_search',
  message: '想看雪山但不想太累,有什么推荐?',
  expected: {
    tools: ['semantic_search_travel', 'search_destinations'],  // 任一命中
    shouldClarify: false
  }
}
```

实测:`npm run eval -- --case sem-01` → 模型调用链 `semantic_search_travel + get_destination_detail`,通过。

### LLM 如何知道何时调

**双重加固**:
- 工具 `description` 写"模糊或难以用关键词表达时优先"(给模型直接的判断依据)
- `v1_base.toolUsageRules[1]` 已经有"模糊需求优先 semantic_search_travel"(system prompt 层兜底)

---

## Task 3.4:混合检索 + RRF

### 新增 `src/rag/hybridSearch.ts`

三策略统一入口:

```ts
export type HybridStrategy = 'keyword' | 'semantic' | 'hybrid'

export async function hybridSearchTravel(
  pool, config, query,
  strategy: HybridStrategy = 'hybrid',
  topK = 5, recallN = 10
): Promise<HybridResult[]> {
  if (strategy === 'keyword')  return await searchDestinations(pool, ...)
  if (strategy === 'semantic') return await createVectorStore(config).query(...)
  // hybrid:RRF 融合两路 + lexical rerank
  const [kw, sem] = await Promise.all([searchDestinations(...), vs.query(...)])
  const fused = rrfFuse(kw, sem)   // score = Σ 1/(60 + rank_i)
  return Array.from(fused).map(([id, e]) => ({
    ..., score: e.score + 0.3 * lexicalOverlapBoost(query, e.bestText)
  })).sort((a,b) => b.score - a.score).slice(0, topK)
}
```

**RRF 公式**:`score(doc) = Σ 1/(k + rank_i)`,k=60 工业默认。

**lexical rerank**:字符 2-gram 重合度,权重 0.3,作为 cross-encoder 的零依赖替代。

**为什么不把 hybrid 注册成 tool**:让模型选 strategy 是设计失败——工具语义应对模型透明,`semantic_search_travel` 就叫"语义检索",hybrid 是底层实现细节。仅供评测脚本 + 未来 toolAgent 用。

### 新增 `scripts/eval-rag.ts`

跑 6 条 query × 3 strategy,看 Top-1 / Top-K 命中率:

```ts
for (const q of QUERIES) {
  for (const strategy of ['keyword','semantic','hybrid']) {
    const hits = await hybridSearchTravel(pool, config, q.query, strategy, TOP_K)
    const top1Hit = q.expected && q.expected.includes(hits[0]?.destinationName)
    ...
  }
}
// 输出:控制台表 + JSON 报告到 docs/02-实验记录/exp-04-*.json
```

### 改 `package.json`

```json
"scripts": { "eval:rag": "tsx scripts/eval-rag.ts", ... }
```

### 实测结果(`exp-04`)

| 策略 | Top-1 召回 |
|------|-----------|
| keyword | 0/6 (0.0%) |
| semantic | 4/6 (66.7%) |
| **hybrid** | **5/6 (83.3%)** |

+16.7pp 的提升来自 q5 "古城慢节奏":semantic 选错哈尔滨,lexical rerank 把"丽江古城"(含"古城"字符)拉回 Top-1。

---

## Task 3.5:溯源 sources 字段

四处串联,把"哪个目的地从哪个工具来的"信息从工具底层透到前端。

### 改 `src/agent/ag-ui.ts`

新增 `Source` 类型 + `RunFinishedEvent.sources`:

```ts
export type Source = {
  destinationId: number
  destinationName: string
  region: string
  via: 'search_destinations' | 'get_destination_detail' | 'semantic_search_travel'
}

export type RunFinishedEvent = BaseEvent & {
  type: EventType.RUN_FINISHED
  ...
  sources?: Source[]   // 新增
}

export function createRunFinished(..., sources?: Source[]): RunFinishedEvent {
  return { ..., sources, timestamp: ts() }
}
```

### 改 `src/agent/tools.ts`

`ToolRunResult` 扩展 + 三个工具填:

```ts
export type ToolSource = { destinationId, destinationName, region, via: ... }
export type ToolRunResult = { text, referencedDestinationIds, sources?: ToolSource[] }

// search_destinations 分支:每个 row 一条 source
return { ..., sources: rows.map(r => ({ ..., via: 'search_destinations' })) }

// get_destination_detail 分支:1 条 source
return { ..., sources: [{ ..., via: 'get_destination_detail' }] }

// semantic_search_travel 分支:按 destinationId 去重
const seenIds = new Set()
for (const r of results) {
  if (seenIds.has(r.metadata.destinationId)) continue
  sources.push({ ..., via: 'semantic_search_travel' })
}
```

### 改 `src/agent/llm.ts`

`runAgentStream` 跨多轮聚合 sources:

```ts
import { type Source, ... } from './ag-ui.js'

const sourceMap = new Map<number, Source>()

// 每轮工具调用后:
if (result.sources) {
  for (const s of result.sources) {
    if (!sourceMap.has(s.destinationId)) sourceMap.set(s.destinationId, s)
    // 同 destinationId 保留首次的 via(语义召回的 destination,后续 detail 也算它的)
  }
}

// 最后 yield RUN_FINISHED 时挂上:
yield createRunFinished(threadId, runId, outcome, totalUsage, Array.from(sourceMap.values()))
```

### 改 `src/agent/prompts/v1_base.ts`

`outputFormat` 加溯源约束 + **反问场景豁免**(踩过坑后加的):

```ts
outputFormat: [
  '回答中可标注目的地 id...',
  // 注意:不是反问场景才标来源,反问要严格 [ASK_USER]/【选项】 字面格式
  '若回答内容来自工具检索结果,**且不是反问场景**,请在回答末尾用简洁列表标注信息来源,例如「(来源:丽江、哈尔滨)」。',
  '当数据库或检索结果不包含用户问的内容时,**必须明确说明"该信息不在我的数据库中"**,不要凭常识硬答。'
]
```

**为什么有"反问场景豁免"**:第一版没加,模型把反问的 `【选项】` 改成了 `【出行时间】`/`【同行人员】` 这种"分类标注",破坏了 `parseAskUser` 的字面契约 → ask-01 fail。加了豁免后复测通过。

---

## 完整调用链路(以 sem-01 为例)

用户问"想看雪山但不想太累" → 走完阶段3 所有改动:

```
1. POST /sessions/:id/stream
       │
       ▼
2. src/index.ts handler:
   detectInjection / insertMessage / listRecentMessages / getPrompt
   → 拼 msgs → runAgentStream
       │
       ▼
3. ReAct Round 1:LLM 看 toolUsageRules[1] "模糊需求优先 semantic"
   → tool_call: semantic_search_travel({query, topK:5})
       │
       ▼
4. tools.ts:runTool 'semantic_search_travel' 分支:
   ├── getVectorStore(config) → ChromaVectorStore lazy 单例
   ├── vectorStore.query(text, 5)
   │     │
   │     ▼
   │   Chroma HTTP POST /api/v2/.../query
   │     ├── (Chroma 内部) embeddingFunction.generate([text])
   │     │   → DeterministicEmbedder 算 128 维向量
   │     └── HNSW 索引 → Top-5 → 返回 { ids, docs, metadatas, distances }
   │
   ├── 对每个 chunk 走 detectInjection(未命中)
   ├── 按 destinationId 去重 sources
   └── return { text:JSON{chunks}, referencedDestinationIds, sources }
       │
       ▼
5. runAgentStream:
   ├── append { role:'tool', content } 到 msgs
   ├── sourceMap.set(26, {destinationName:'丽江', via:'semantic_search_travel'})
   └── continue 下一轮
       │
       ▼
6. ReAct Round 2:LLM 看 tool result,识别"丽江匹配"
   → tool_call: get_destination_detail({destination_id:26})
       │
       ▼
7. tools.ts:get_destination_detail 分支:
   SQL 查 destinations + features → return { ..., sources: [{via:'get_destination_detail'}] }
       │
       ▼
8. runAgentStream:sourceMap.has(26) 已存,via 保留首次
       │
       ▼
9. ReAct Round 3:LLM 整合答案,带 "(来源:丽江)" 标签
       │
       ▼
10. yield RUN_FINISHED { outcome, usage, sources:[丽江] }
       │
       ▼
11. handler:detectSystemLeak / insertMessage(assistant) / updateSessionTokens / end
       │
       ▼
12. 前端 RUN_FINISHED.sources → 渲染"信息来源:丽江"
```

---

## 附录:全部代码改动速查

| 改动类型 | 路径 |
|---------|------|
| **新增** | `src/rag/types.ts` |
| | `src/rag/chunker.ts` |
| | `src/rag/embedder.ts` |
| | `src/rag/vectorStore.ts` |
| | `src/rag/hybridSearch.ts` |
| | `scripts/index-vectors.ts` |
| | `scripts/eval-rag.ts` |
| **改动** | `src/agent/tools.ts`(加 semantic_search_travel + sources) |
| | `src/agent/ag-ui.ts`(加 Source 类型 + RunFinishedEvent.sources) |
| | `src/agent/llm.ts`(加 sourceMap 跨轮聚合) |
| | `src/agent/prompts/v1_base.ts`(outputFormat 加溯源约束 + 反问豁免) |
| | `src/eval/testset.ts`(sem-01 转入硬性评估) |
| | `src/config.ts`(CHROMA_* / EMBEDDING_*) |
| | `docker-compose.yml`(chroma service) |
| | `package.json`(chromadb 依赖 + index/eval:rag scripts) |
| | `.env`(CHROMA_* / EMBEDDING_*) |
| **产出** | `docs/02-实验记录/exp-04-hybrid-vs-pure.md`(+JSON 报告) |
| | `docs/04-架构文档/agent-架构.md`(§1.1 / §3.6 / §4.4 / §5.7~§5.8 同步) |

---

## 验证命令

```bash
# 1. 容器健康
docker ps --format "{{.Names}}: {{.Status}}" | grep -E "mysql|chroma"

# 2. 重灌(改 seed 或切 embedder 后必跑)
npm run index

# 3. 单 case 验证 RAG 工具能被正确选择
npm run eval -- --version v1_base --case sem-01 --sleep 100

# 4. 三策略对比
npm run eval:rag

# 5. 回归(确保 RAG 没破其他 case)
npm run eval -- --case ask-01,detail-01,inj-01 --sleep 1000
```
