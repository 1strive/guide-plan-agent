# 阶段3 学习笔记:RAG 接入(Chroma + 多 Embedder + 混合检索 + 溯源)

> **本文目标**:把阶段3 的 6 个 Task——Chunk 切分、Embedder 抽象、Chroma 向量库、`semantic_search_travel` 工具、RRF 混合检索、溯源——和**已经写出来的代码 + 实测数据**绑在一起讲清楚。读完你应该能:面试时把"为什么用 Chroma 不用 Milvus / 为什么 Embedder 要抽象成接口 / 混合检索如何在 Top-1 上提升 16.7pp"讲到根因层、改一条 RAG 链路时知道每一步会动到什么、读八股 03 不再吃力。
>
> **读者画像**:已经读完 [`note-01`](./note-01-阶段1-LLM基础三件套.md) 和 [`note-02`](./note-02-阶段2-prompt-engineering.md)、对 LLM + Prompt 有工程级认知的开发者。
>
> **关联**:
> - 规划:`docs/开发规划.md` 阶段3 Task 3.1~3.5(已完成)
> - 八股:`docs/01-面试八股文/03-RAG技术.md`(全篇,重点 §1 概念、§2 切分、§3 向量化、§5 混合检索、§6 重排序)
> - 代码:`src/rag/`、`src/agent/tools.ts:semantic_search_travel`、`scripts/index-vectors.ts`、`scripts/eval-rag.ts`
> - 实验:`docs/02-实验记录/exp-04-hybrid-vs-pure.md`(本阶段产出)
> - 架构:`docs/04-架构文档/agent-架构.md` §1.1 / §3.6 / §4.4 / §5.7~§5.8

---

## 引言:阶段2 给了 prompt,阶段3 给了"知识"

阶段2 让模型"答得稳"(prompt 版本化 + Few-shot + CoT + 评测),阶段3 让模型"答得**准**"——给它一个**外挂的可检索知识库**,而不是全靠预训练时学到的东西。

打个比方:
- 阶段2 = 教医生怎么问诊(看面色、问症状、开处方的规范)
- 阶段3 = 给医生一本《诊疗手册》(实时可查)

没有 RAG,模型只能凭"想当然"答:
```
用户:丽江有什么美食?
模型:腊排骨、过桥米线、纳西烤鱼...      ← 凭训练记忆,可能错也可能没
```

有了 RAG:
```
用户:丽江有什么美食?
模型:先调 get_destination_detail(2) → 拿到我们 DB 里实存的{腊排骨火锅,鸡豆凉粉}
     "丽江的代表性美食:腊排骨火锅 / 鸡豆凉粉..."   ← 有依据,可溯源
```

阶段3 的 6 个 Task 把这套"检索 → 喂给模型 → 答案"的流水线全链路搭起来:

| Task | 解决什么 | 对应八股 |
|------|--------|---------|
| 3.1 切分与 Embedder | 文本 → chunk → 向量 | 03 §2 / §3.1 |
| 3.2 Chroma 向量库 | 向量存哪儿、怎么查 | 03 §3.2 / §4 |
| 3.3 `semantic_search_travel` 工具 | 让 LLM 学会"何时调 RAG" | 03 §1 + 04 工具调用 |
| 3.4 混合检索 + 重排序 | 单路语义有盲区,加 lexical 兜底 | 03 §5 / §6 |
| 3.5 生成与溯源 | 让答案带"信息来源"标签 | 03 §7 / 09 §6 |

**阅读路径**:
- 想快速了解 RAG 全链路 → 跳到**第七部分:完整调用链路(全景)**
- 想准备面试 → 重点读第四部分(工具抽象层)和第八部分(实测踩坑)
- 想系统补完 → 顺读

---

## 前置:什么是 RAG,为什么需要

### RAG 的全称与本质

**RAG = Retrieval-Augmented Generation(检索增强生成)**。

**本质**:在 LLM 生成答案**之前**,先用相关的外部知识"增强"它的输入,让生成结果有事实依据。

### 为什么 LLM 自己不够

| LLM 单靠自身 | 痛点 |
|------------|------|
| 训练知识截止时间 | "2026 年春节有什么活动" 训练时不存在 |
| 不知道私有数据 | "我们公司的请假流程"——模型没见过 |
| 容易编造细节 | 问"丽江某餐厅营业时间",会编一个看起来对的答案 |
| 知识更新成本高 | 更新模型 = 重新训练,千万美元起步 |

**RAG 的解法**:把"知识库"和"模型"解耦——
- 模型负责**推理 + 生成**
- 外部检索系统负责**召回相关事实**
- 知识库可以随时增删改,无需重训模型

### RAG 的最小公式

```
用户问题
   │
   ▼
[检索] 从知识库取 Top-K 相关片段(chunks)
   │
   ▼
[拼接] 把 chunks 塞到 prompt 里(或作为 tool result)
   │
   ▼
[生成] LLM 基于 query + chunks 生成最终答案
```

阶段3 把这三步都工程化了:**切分(为检索做准备)+ 向量化(为相似度匹配做准备)+ 存储(Chroma)+ 检索接口(VectorStore.query)+ 工具暴露(让 LLM 主动调)+ 溯源(让答案可核对)**。

---

## 第一部分:Chunk 切分(Task 3.1 之一)

### 1.1 为什么要切分

LLM 的上下文窗口有限(几千 ~ 几十万 token),不可能每次把整个知识库塞进去。所以必须切成**小片段(chunk)**,每次只取 Top-K 相关的喂给模型。

切分还有**第二个目的**:让向量相似度算得准——一段太长的文本(比如整个目的地介绍)的向量是"平均化"的,跟用户的精确 query 难匹配;切成"丽江美食"、"丽江景点"这种主题集中的小块,向量更聚焦。

### 1.2 我们项目的切分策略(`src/rag/chunker.ts`)

```ts
// 两类 chunk:
1. destinations.summary → 1 个 chunk (category='summary')
2. destination_features 每条 → 1 个 chunk (category='food'/'scenery'/'culture')
```

| 来源表 | 行数 | chunk 数 |
|--------|------|---------|
| destinations | 3 | 3 |
| destination_features | 15 | 15 |
| **合计** | — | **18** |

### 1.3 关键设计:为什么不做 overlap

八股 03 §2 提到"overlap"(切片之间重叠几个字符)是常见做法,**我们刻意没做**:

| 场景 | overlap 价值 |
|------|------------|
| 长文档(论文、小说) | ✅ 有用,避免一句话被切断后两块都不完整 |
| 我们的项目(结构化条目) | ❌ 没用,每条 feature 是独立"美食/景点"条目,无上下文关联 |

**强加 overlap 反而引入噪声**——例如把"火锅" feature 和"小吃" feature 的描述粘到一起,向量混了两个主题。

### 1.4 第二个设计:chunk text 带"自带上下文"的前缀

不是裸把 `description` 当 chunk text,而是拼:

```ts
text: `${destName}的${categoryLabel(category)}「${title}」:${description}`
// 例如:"丽江的美景「玉龙雪山」:雪山景观突出,注意高反与索道预约。"
```

为什么:

- 模型看到的 chunk 是孤立的(没行号、没表名),如果只写 "雪山景观突出..." 它不知道"哪儿的雪山"
- 拼上"丽江的美景"前缀,**chunk 自我描述完整**,模型即使只看一条也能定位

### 1.5 metadata 设计

每个 chunk 带:

```ts
metadata: {
  destinationId: number,
  destinationName: string,
  region: string,
  category: 'summary' | 'food' | 'scenery' | 'culture',
  source: 'summary' | 'feature'
}
```

**用途**:Chroma 查询时可做 `where` 过滤(如 `where: { category: 'food' }` 只搜美食类),也用于 §5 的溯源——`sources` 字段从这里来。

### 1.6 面试速答模板

> "我把 destinations + destination_features 两张表切成 18 个 chunk:summary 1 个/目的地 + 每个 feature 1 个。**不做 overlap**——条目独立无上下文关联,overlap 反而引入噪声。**chunk text 前缀加目的地名 + 类别**(如『丽江的美景「玉龙雪山」』),让 chunk 自我描述完整;metadata 留了 category 和 destinationId,既给 Chroma 元数据过滤用,也给阶段5 sources 溯源用。"

---

## 第二部分:Embedder 抽象与多 Provider(Task 3.1 之二)

### 2.1 什么是 Embedding

**Embedding = 把文本变成向量**。一段文本 → 一组数字(几百到几千维),目的是让"语义相似的文本"在向量空间里**距离近**。

```
"丽江的雪山"        → [0.12, -0.34, 0.56, ...]
"玉龙山的景色"       → [0.15, -0.31, 0.58, ...]   ← 距离近(语义相似)
"成都的火锅"        → [0.78,  0.42, -0.12, ...]   ← 距离远(完全不同主题)
```

**核心机制**:embedding 模型是个"语义编码器",经过海量训练后能把"意思相近"映射到"向量空间相近"。

### 2.2 为什么 Embedder 必须抽象

阶段3 实施时碰到一个非常真实的工程问题:**MiniMax 当前账号无 embedding 权限**(实测 `embo-01` 返回 `your current token plan not support model, embo-01`)。

可选 provider:
- MiniMax `embo-01`(我们用的 LLM 是 MiniMax,但账号不支持)
- OpenAI `text-embedding-3-small`(需真 OpenAI key)
- 本地 ollama / sentence-transformers
- ...

**如果硬编码到 MiniMax,RAG 全链路卡在第一步跑不通**。所以必须抽象:

```ts
// src/rag/embedder.ts
export interface Embedder {
  readonly name: string
  readonly dim: number
  generate(texts: string[]): Promise<number[][]>
}
```

任何 provider 实现这个接口,业务代码(chunker / vectorStore)只依赖接口。

### 2.3 三个实现的对比

| 实现 | 维度 | 真语义? | 成本 | 使用场景 |
|------|------|--------|------|---------|
| `MinimaxEmbedder` (`embo-01`) | 1536 | ✅ | API key | MiniMax 账号支持 embedding 时 |
| `OpenAIEmbedder` (`text-embedding-3-small`) | 1536 | ✅ | API key + 流量 | 最快验证真语义,需 OpenAI key |
| **`DeterministicEmbedder` (`/128d`)** | 128 | ❌ 字符 n-gram | 0 | **当前默认**,完全离线,流程能跑 |

### 2.4 DeterministicEmbedder 的算法(完全离线兜底)

```ts
1. 文本切字符 2-gram + 3-gram(如 "丽江古城" → ["丽江","江古","古城","丽江古","江古城"])
2. 每个 n-gram 用 FNV-1a 哈希到 [0, 128) 的某一维,该维 +1
3. L2 归一化
```

**性质**:
- ✅ 相同文本 → 相同向量
- ✅ 相似文本(共享 n-gram 多)→ cosine 较高
- ❌ **不能捕捉真语义**——"辣" 和 "火锅" 完全无关(没共享 n-gram)

这是关键局限,**第八部分实测会展示它的"失败之美"**——q2 "推荐一个吃辣的地方" 选了哈尔滨,因为 deterministic 没法把"辣"和"火锅"关联。

### 2.5 切换 provider 是一行 .env

```env
# 当前
EMBEDDING_PROVIDER=deterministic
EMBEDDING_DIM=128

# 切到 OpenAI
EMBEDDING_PROVIDER=openai
# 加 OPENAI_BASE_URL=https://api.openai.com/v1
# 加 OPENAI_API_KEY=sk-...
```

切完必须重灌(维度变了,旧向量对不上):

```bash
npm run index
```

这就是**抽象的工程价值**——一行配置 + 一条命令完成 provider 切换,业务代码 0 改动。

### 2.6 面试速答模板

> "Embedder 我抽象成了接口,3 个实现:minimax / openai / **deterministic**。原因是 RAG 实施时 MiniMax 账号没 embedding 权限,如果硬编码会卡在第一步。Deterministic 是字符 n-gram 哈希算法 + L2 归一化,完全离线、零依赖,让整条 RAG 流水线先跑通——但语义有限,'辣'和'火锅'匹配不上。切到真 embedder 改一行 `.env` + `npm run index` 重灌,业务代码 0 改动。**这就是为什么所有外部依赖都要先做抽象层——你永远不知道哪个 provider 会卡你。**"

---

## 第三部分:Chroma 向量库(Task 3.2)

### 3.1 为什么选 Chroma(不选 MySQL / Milvus / Pinecone)

阶段3 落地前 5 分钟做了一次选型决策(写在 `docs/开发规划.md` 关键设计决策 #2):

| 方案 | 评价 |
|------|------|
| **MySQL JSON 列存向量**(原计划 MVP) | ❌ 全表扫描算内积无索引,几千 chunk 就慢;不能讲行业标准接口;玩具感强 |
| **Milvus / Pinecone**(生产级) | ❌ 运维成本与我们"几百个目的地"的数据规模不匹配,"为什么选 Milvus" 难自圆其说 |
| **Chroma**(实际选择) | ✅ docker 一键起;OpenAI/LangChain 生态;内置 HNSW 索引;能讲清楚选型理由 |

**Chroma 的甜蜜点**:几千~几十万向量、单机或小集群、想快速验证 RAG。**我们项目 18 chunk 用 Chroma 是性能上的"完全冗余"**——选它是为了学**行业标准接口**而非性能。

### 3.2 Chroma 的三个核心概念

#### Collection(集合)

类比 SQL 的 table + 向量索引一体化:

```ts
const collection = await client.getOrCreateCollection({
  name: 'destinations_v1',
  embeddingFunction: asEmbeddingFunction(embedder),
  metadata: {
    'hnsw:space': 'cosine',           // 相似度度量:cosine / l2 / ip
    embedder_name: embedder.name,
    embedder_dim: embedder.dim
  }
})
```

一个 collection 同时管理:**向量 + 原始文本 + 元数据 + ID**。

#### EmbeddingFunction(嵌入函数)

Chroma 把"文本 → 向量"的过程内置——**add 时不必手动算 embedding**:

```ts
await collection.add({
  ids: ['chunk_1'],
  documents: ['丽江古城...'],          // 直接给文本
  metadatas: [{ destination_id: 2 }]
  // 没有 embeddings 字段!Chroma 自动调 embeddingFunction.generate()
})
```

我们的 `ChromaVectorStore` 把项目的 `Embedder` 包装成 chromadb 要求的 `EmbeddingFunction`:

```ts
function asEmbeddingFunction(embedder: Embedder): EmbeddingFunction {
  return {
    name: embedder.name,
    generate: (texts: string[]) => embedder.generate(texts)
  }
}
```

#### Query(查询)

```ts
const result = await collection.query({
  queryTexts: ['想看雪山不想太累'],
  nResults: 5,
  where: { category: 'scenery' }  // 元数据过滤(类似 SQL WHERE)
})
// → { ids: [[...]], documents: [[...]], metadatas: [[...]], distances: [[...]] }
```

注意外层是数组——因为 `queryTexts` 可以传多个查询一次性算。

### 3.3 VectorStore 抽象层(`src/rag/vectorStore.ts`)

跟 Embedder 一样的工程模式:抽象接口 + Chroma 实现,留切 Milvus 的口。

```ts
export interface VectorStore {
  add(chunks: Chunk[]): Promise<void>
  query(text: string, topK: number, filter?: Record<string, unknown>): Promise<SearchResult[]>
  count(): Promise<number>
  reset(): Promise<void>  // 灌数据脚本用
}
```

业务代码(`tools.ts:semantic_search_travel`、`hybridSearch.ts`)只 import 接口,不 import Chroma。

### 3.4 灌数据流程(`scripts/index-vectors.ts`)

```bash
npm run index
```

它做的事:

```
1. buildAllChunks(pool)        ← 从 MySQL 读 18 个 chunk
2. vectorStore.reset()         ← drop 旧 collection,避免 embedder 维度切换冲突
3. vectorStore.add(chunks)     ← Chroma 自动调 embedder.generate() 算向量入库
4. vectorStore.count()         ← 校验:应该是 18
5. 跑 3 条 smoke query 看 Top-3   ← 验证检索通路
```

实测速度:18 chunks × deterministic embedder = **55ms 灌完**(本机)。

### 3.5 两层架构:MySQL 是真理,Chroma 是可丢弃的索引

```
┌──────────────┐  npm run index    ┌──────────────┐
│  MySQL      │ ──────────────────►│  Chroma      │
│  (source    │                    │  (索引衍生物) │
│   of truth) │                    └──────────────┘
└──────────────┘
```

**含义**:
- MySQL 改了数据 → Chroma 不会自动同步,**必须 `npm run index`**
- Chroma 容器挂了 / 数据丢了 → 重跑 `npm run index` 完整恢复,无业务损失
- embedding 模型升级了(deterministic → openai)→ `vectorStore.reset()` + `npm run index` 全量重灌

这是 RAG 系统的核心架构原则——**不要把检索索引当真理,真理永远在原始数据**。

### 3.6 面试速答模板

> "向量库我选了 Chroma 而不是 MySQL JSON 列或 Milvus——理由是数据规模匹配 + 行业标准接口 + docker 友好。`ChromaVectorStore` 实现了 `VectorStore` 接口,把 `Embedder` 包成 `EmbeddingFunction` 注入 collection,这样 `add` 时不用预先算 embedding,Chroma 自动调。**两层架构原则**:MySQL 是真理,Chroma 是可丢弃的索引衍生物——改 seed 必须重跑 `npm run index`,但 Chroma 挂了无业务损失。Collection metadata 用 `hnsw:space=cosine` 对齐主流 RAG 实践。"

---

## 第四部分:`semantic_search_travel` 工具(Task 3.3)

### 4.1 工具暴露给 LLM:模型如何"学会调 RAG"

写一个能 RAG 的函数不够——还得让 **LLM 知道何时调用它**。这是 function calling 的核心。

`src/agent/tools.ts:definitions` 增加第 3 个工具:

```ts
{
  type: 'function',
  function: {
    name: 'semantic_search_travel',
    description:
      '按自然语言"感觉/偏好/灵感"做向量语义检索(例如「想看雪山又不想太累」「适合带娃的慢节奏目的地」)。' +
      '当用户描述模糊或难以用关键词表达时优先使用此工具。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言需求描述' },
        topK: { type: 'integer', description: '返回 Top-K 条结果', default: 5 },
        category: {
          type: 'string',
          enum: ['summary', 'food', 'scenery', 'culture']
        }
      },
      required: ['query']
    }
  }
}
```

**关键点**:`description` 字段就是给 LLM 看的——它根据这段描述决定何时调。"模糊或难以用关键词表达时优先" 是核心触发词。

同时 `src/agent/prompts/v1_base.ts:toolUsageRules[1]` 也再加一层规则:

> "当用户描述模糊、或需要灵感匹配(例如「想看雪山又不想太累」)时,优先调用 semantic_search_travel..."

**双重加固**:工具 description + system prompt 规则,降低模型选错工具的概率。

### 4.2 调用链路(`tools.ts:runTool('semantic_search_travel')`)

```ts
1. getVectorStore(config) → lazy 单例 ChromaVectorStore
2. vectorStore.query(query, topK, filter)
   - Chroma client → POST http://localhost:8000/api/v2/.../query
   - Chroma 内部:embeddingFunction.generate([query]) → 拿到 query 向量
   - HNSW 索引算 cosine 距离 → Top-K → 返回 chunks
3. 对每个 chunk 文本走 detectInjection(防间接注入)
   - 命中 → wrapUntrusted 包裹
4. 按 destinationId 去重收集 sources(给 Task 3.5 用)
5. 返回 ToolRunResult { text, referencedDestinationIds, sources }
```

### 4.3 间接注入防御:RAG 检索内容也是"用户输入"

阶段2 §5.6 留过一个 STAR 故事的伏笔:**"RAG 检索回来的 chunk 也可能含恶意指令"**——网页文档 / 第三方源 / 被污染的数据库行——这些一旦拼进 prompt,模型可能被骗着执行。

阶段3 顺手把这个坑补完(`tools.ts:semantic_search_travel`):

```ts
const safeChunks = results.map((r) => {
  const inj = detectInjection(r.text)
  return {
    ...
    text: inj.matched ? wrapUntrusted(r.text) : r.text,
    injectionDetected: inj.matched ? inj.severity : undefined
  }
})
```

**当前数据来自自家 seed,理论上不会命中**——但代码就位,等阶段3.7 接入 Tavily 联网搜索后立即生效。

### 4.4 与 SQL 工具的关系:互补,不替代

阶段3 后,模型有 3 个工具:

| 工具 | 适用场景 |
|------|---------|
| `search_destinations`(SQL LIKE) | 明确关键词/地区(如"云南目的地") |
| `get_destination_detail`(SQL by id) | 列举具体条目(必调,禁止编造) |
| `semantic_search_travel`(RAG) | 模糊需求("想看雪山不想太累") |

**模型按 system prompt 决策路径自主选**。`sem-01` 实测正好演示了"模型选 semantic 兜底场景":

```
模型链路:semantic_search_travel('想看雪山...')  ← 语义召回找方向
       → get_destination_detail(丽江)         ← SQL 拿精确条目
       → 整合答案
```

### 4.5 面试速答模板

> "新增的 `semantic_search_travel` 工具是 RAG 的入口。它通过两层加固让 LLM 知道何时调:① 工具 description 写明『模糊或难以用关键词表达时优先』;② system prompt `toolUsageRules` 再加一条规则。**内部 4 步**:lazy 拿 vectorStore 单例 → Chroma 查 Top-K → 每条 chunk 走 detectInjection(防间接注入,阶段2 §5.6 伏笔)→ 按 destinationId 去重收集 sources。这工具**不替代 SQL,是互补**——sem-01 实测显示模型会先 semantic 兜底找方向,再 SQL 拿精确事实。"

---

## 第五部分:混合检索与 RRF(Task 3.4)

### 5.1 单路检索的两个盲区

| 单路 | 盲区 |
|------|------|
| 纯关键词(SQL LIKE) | "想看雪山不想太累" 整句不会在 summary 字段——召回 0 条 |
| 纯语义(向量) | 字面信号被忽略——"古城慢节奏" 的"古城"被语义算成跟雪山等价 |

实测数据(`exp-04` 第一轮,deterministic embedder):

```
Top-1 召回率:
  keyword  0/6 (0.0%)         ← 全部 query 整句无 LIKE 命中
  semantic 4/6 (66.7%)         ← 真有 4 条命中,但 q2 "辣→火锅" / q5 "古城慢节奏" 错位
```

### 5.2 RRF(Reciprocal Rank Fusion)是什么

**核心公式**:

```
score(doc) = Σ 1 / (k + rank_i)
            i ∈ {keyword, semantic}

k 工业默认 60(经验值,弱化高排名的过度权重)
rank_i = 该 doc 在第 i 路检索结果里的排名(从 0 开始)
```

**为什么用 RRF 而不是分数线性加权**:

| RRF | 线性加权(score = w1·k_score + w2·s_score) |
|-----|---------------------------------------|
| 不关心两路分数的绝对值,只用 rank | 需要先归一化 keyword/semantic 分数到同一尺度 |
| 工业默认 k=60 即用即跑 | 权重 w1/w2 要按数据调 |
| 一路返回空也无副作用 | 一路空时另一路被错放大 |

**RRF 是检索融合的 sane default**,工程项目首选。

### 5.3 lexical rerank:cross-encoder 的轻量替代

我们没接 cross-encoder(如 `bge-reranker-base`),用了一个简单的 **lexical overlap** 二次排序:

```ts
function lexicalOverlapBoost(query: string, text: string): number {
  // 字符 2-gram 重合度
  const qg = grams(query)
  const tg = grams(text)
  let hit = 0
  for (const g of qg) if (tg.has(g)) hit++
  return qg.size > 0 ? hit / qg.size : 0
}
```

**最终 score = RRF + 0.3 × lexicalOverlap**(0.3 是实测可调的权重)。

**为什么不上 cross-encoder**:
- 零依赖,纯 JS
- 可解释,面试能讲清算法
- 生产升级路径明确(换 cross-encoder 只改这一个函数)

### 5.4 实测:hybrid 提升 +16.7pp

`docs/02-实验记录/exp-04-hybrid-vs-pure.md`:

| 策略 | Top-1 召回 |
|------|-----------|
| keyword | 0/6 (0.0%) |
| semantic | 4/6 (66.7%) |
| **hybrid** | **5/6 (83.3%)** |

**+16.7 个百分点(pp)**——关键功臣是 `q5 "古城慢节奏"`:

```
semantic Top-3: 哈尔滨 / 丽江 / 丽江        ← Top-1 错位
hybrid   Top-3: 丽江 / 哈尔滨               ← lexical "古城" 重合度把丽江拍上来
```

### 5.5 hybrid 不暴露为新 tool 的决策

`hybridSearchTravel` 函数对外提供 keyword/semantic/hybrid 三策略切换,但**不注册成 LLM 可调用的 tool**。原因:

- 让模型选 strategy 是设计失败——模型不应该懂"什么时候用 hybrid"
- 工具语义应当**对模型透明**:`semantic_search_travel` 就叫"语义检索",hybrid 是底层实现细节
- hybrid 仅供**评测脚本**(`scripts/eval-rag.ts`)和**未来 toolAgent**(Task 5.1)使用

### 5.6 面试速答模板

> "混合检索我用了 RRF(Reciprocal Rank Fusion)+ lexical rerank。RRF 选它因为不用归一化两路分数尺度,工业默认 k=60 开箱即用。lexical rerank 是 cross-encoder 的零依赖替代——字符 2-gram 重合度,权重 0.3。实测在 deterministic embedder 下 **hybrid 比 semantic Top-1 提升 +16.7pp**,功臣是 'q5 古城慢节奏'——semantic 因为'古城'字面信号弱选了哈尔滨,lexical 把丽江拉回 Top-1。**关键设计**:hybrid 不暴露给 LLM 当 tool——选 strategy 是工程决策,不是模型决策,工具语义应对模型透明。"

---

## 第六部分:生成与溯源(Task 3.5)

### 6.1 为什么需要溯源

RAG 解决了"事实依据"问题,但**用户怎么知道哪段答案是从知识库拿的**?

```
答案:"丽江推荐玉龙雪山,海拔 5596 米"
      ↑                ↑
      RAG 检索         模型常识(可能错)
```

没有溯源:用户没法核对,跟没 RAG 差不多。

### 6.2 三件事的串联

#### 1. `Source` 类型(`src/agent/ag-ui.ts`)

```ts
export type Source = {
  destinationId: number
  destinationName: string
  region: string
  via: 'search_destinations' | 'get_destination_detail' | 'semantic_search_travel'
}
```

`via` 字段标识"召回方式",便于审计:模型用 RAG 找到的 vs 用 SQL 找到的。

#### 2. 工具返回 sources(`tools.ts:ToolRunResult`)

```ts
export type ToolRunResult = {
  text: string
  referencedDestinationIds: number[]
  sources?: ToolSource[]   // 新增
}
```

三个工具都填:
- `search_destinations` → 每个 row 一条 source
- `get_destination_detail` → 1 条 source
- `semantic_search_travel` → 按 destinationId 去重的 sources

#### 3. `runAgentStream` 跨多轮聚合(`llm.ts`)

```ts
const sourceMap = new Map<number, Source>()

// 每轮工具调用后:
if (result.sources) {
  for (const s of result.sources) {
    if (!sourceMap.has(s.destinationId)) sourceMap.set(s.destinationId, s)
  }
}

// 最后 RUN_FINISHED:
yield createRunFinished(threadId, runId, outcome, totalUsage, Array.from(sourceMap.values()))
```

前端从 `RUN_FINISHED.sources` 渲染"信息来源"标签。

### 6.3 prompt 加溯源约束(踩坑实录)

`v1_base.outputFormat` 加了一条:

> "若回答内容来自工具检索结果...请在回答末尾用简洁列表标注信息来源,例如「(来源:丽江、哈尔滨)」"

**第一版踩坑**:加完后 `ask-01` 反问 case fail 了——模型把 `[ASK_USER]` 反问场景下的 `【选项】` 改成了 `【出行时间】`/`【同行人员】` 这种"分类标注",破坏了 `parseAskUser` 的字面解析契约。

**根因**:加了溯源约束让模型在所有场景下都倾向"分类标注",溢出到反问场景。

**修复**:在溯源规则里加**反问场景豁免**:

> "...,且不是反问场景,请在回答末尾用简洁列表标注信息来源..."

复测 ask-01 / detail-01 全通过。

### 6.4 面试速答模板

> "溯源我做了三件事:① `Source` 类型加 `via` 字段标记召回方式;② 三个工具的 `ToolRunResult` 都返 sources;③ `runAgentStream` 用 sourceMap 跨多轮去重聚合,挂到 `RUN_FINISHED.sources` 透给前端。**踩过的坑**:第一版溯源约束让模型在反问场景把 `【选项】` 改成 `【出行时间】` 等分类标题,破坏了 `parseAskUser` 的字面契约——修复是给约束加'反问场景豁免'。这是个**典型的 prompt 跨场景污染问题**,说明加任何约束都要考虑它跟现有协议的兼容性。"

---

## 第七部分:完整调用链路(RAG 全景)

这是阶段3 最值得记住的"一图全懂"。以 `sem-01` 实测 case 为例:

### 7.1 用户问"想看雪山但不想太累"的完整流转

```
1. 用户输入
       │
       ▼
2. POST /sessions/:id/stream { message: "想看雪山但不想太累" }
       │
       ▼
3. src/index.ts handler:
   ├── detectInjection("想看雪山...") → 未命中
   ├── insertMessage(user) 写库
   ├── listRecentMessages 取历史
   ├── getPrompt('v1_base') → { system, prependMessages }
   └── 拼 msgs = [system, ...few-shot, ...history]
       │
       ▼
4. runAgentStream 进入 ReAct 主循环
       │
       ▼
5. LLM 看 system 里 toolUsageRules:"模糊需求优先 semantic_search_travel"
   LLM 输出 tool_call: semantic_search_travel({
     query: "想看雪山但不想太累", topK: 5
   })
       │
       ▼
6. tools.ts:runTool 'semantic_search_travel' 分支:
   │
   ├── getVectorStore(config) → ChromaVectorStore 单例(lazy)
   │
   ├── vectorStore.query("想看雪山...", 5)
   │   │
   │   ▼
   │   Chroma collection.query({ queryTexts: ["想看雪山..."], nResults: 5 })
   │   │
   │   ├── (Chroma 内部) embeddingFunction.generate(["想看雪山..."])
   │   │   → DeterministicEmbedder: 字符 n-gram → 128 维向量
   │   │
   │   ├── HNSW 索引算 cosine 距离 → 排序 → Top-5
   │   │
   │   └── 返回 { ids: [...], documents: [...], metadatas: [...], distances: [...] }
   │
   ├── 对每个 chunk 走 detectInjection(防间接注入)
   │   → 未命中,文本不包裹
   │
   ├── 按 destinationId 去重收集 sources
   │   → [{destinationId:26, destinationName:'丽江', region:'云南', via:'semantic_search_travel'}, ...]
   │
   └── 返回 { text: JSON{chunks:[...]}, referencedDestinationIds: [26,...], sources: [...] }
       │
       ▼
7. runAgentStream 收到 tool result:
   ├── append { role: 'tool', tool_call_id, content: 工具返回的 JSON } 到 msgs
   ├── sourceMap.set(26, {destinationName:'丽江',...})  ← 聚合 source
   └── continue 下一轮 ReAct
       │
       ▼
8. LLM 看到工具结果,识别"丽江是匹配项"
   LLM 输出 tool_call: get_destination_detail({ destination_id: 26 })
       │
       ▼
9. tools.ts:runTool 'get_destination_detail' 分支:
   ├── SELECT destinations WHERE id=26 → 丽江
   ├── SELECT destination_features WHERE destination_id=26
   ├── sources += [{destinationId:26, via:'get_destination_detail'}]
   │   (但 sourceMap.has(26) 已存,via 保留首次 'semantic_search_travel')
   └── 返回 { text: JSON{destination, features}, sources: [...] }
       │
       ▼
10. LLM 再看,组织最终答案:
    "为您推荐丽江...(玉龙雪山高反需注意,坐索道很省力)...
     (来源:丽江)"      ← 溯源标签
       │
       ▼
11. runAgentStream yield 文本内容 → AG-UI TEXT_MESSAGE_CONTENT
       │
       ▼
12. 流结束 → yield RUN_FINISHED { outcome:'success', usage, sources:[丽江] }
       │
       ▼
13. handler:
    ├── detectSystemLeak(finalText, system) → 未命中
    ├── insertMessage(assistant, finalText) 落库
    ├── updateSessionTokens(累加)
    └── reply.raw.end()
       │
       ▼
14. 前端解析 SSE 流:
    ├── TEXT_MESSAGE_CONTENT × N → 累加显示
    └── RUN_FINISHED.sources → 渲染"信息来源:丽江"标签
```

**实测数据**(`exp-02-prompt-versions-2026-05-30T14-17-26-973Z.json`):
- 总耗时:15817ms(15.8s)
- 总 tokens:5373
- 工具调用:`['semantic_search_travel', 'get_destination_detail']`
- check:tool ✓ / clarify ✓(其他维度未设)

### 7.2 关键观察点

1. **模型完全按 prompt 规则决策**——`toolUsageRules[1]` 写"模糊需求优先 RAG",`<think>` 阶段直接复述这条规则
2. **RAG + SQL 自然协作**——模型先 RAG 找方向,再 SQL 拿事实,完全符合"RAG 兜底 + SQL 补真相"的设计
3. **sources 跨工具聚合**——丽江被两个工具都引用,sourceMap 去重,via 保留首次(semantic_search_travel)
4. **整条链路 0 手写编排**——模型根据工具 description + system prompt 自主选择,这就是 Agent 的核心

---

## 第八部分:实测发现实录

> 这一节是阶段3 最有面试价值的内容,跟 note-02 §5 一样,故事的力量永远大于"我做了什么"。

### 8.1 deterministic 的"失败之美":辣 ≠ 火锅

`exp-04` 第一轮跑 q2 "推荐一个吃辣的地方":

| 策略 | Top-3 | Top-1 命中? |
|------|------|-----------|
| keyword | (空) | ✗ |
| semantic | 哈尔滨 / 丽江 / 哈尔滨 | ✗ |
| hybrid | 哈尔滨 / 丽江 | ✗ |

**所有策略都没选成都(应该是成都火锅)**。根因清晰:

- deterministic 算法是字符 n-gram 哈希
- "辣" 字根本不出现在 chunk text 里(成都美食里写的是"火锅"、"麻辣"、"串串")
- "辣"和"火锅"的 n-gram 完全不重合 → cosine 距离很大

**这是 deterministic 的根本局限**——它不"理解"语义,只看字面重合。换 OpenAI/Minimax 的真 embedder 后,大概率能修复,因为真模型知道"辣"和"火锅"语义相近。

**STAR 故事价值**:这是一个**完美的"工程权衡可见 + 升级路径明确"案例**——临时方案的局限被实测精准暴露,升级到真 embedder 是一行 .env 的事,接口已就位。

### 8.2 "古城慢节奏"被 hybrid 救回的故事

q5 "古城慢节奏" semantic 选了哈尔滨(应为丽江)。看具体数字:

```
semantic Top-3:
  [0.284] 哈尔滨/中央大街 ← 距离最近(错位)
  [0.277] 丽江/丽江古城
  [0.235] 丽江/玉龙雪山

hybrid Top-3 (RRF + lexical):
  score = RRF + 0.3 * lexicalOverlap
  
  丽江古城:  RRF = 0.0167 + 0.0166 = 0.033
             lexicalOverlap = 高(query "古城" 与 text "丽江古城" 命中字符)
             total ≈ 0.154 ← Top-1 ✓
  
  哈尔滨中央大街: RRF = 0.0166
             lexicalOverlap = 低(无 "古" "城" "慢" "节" "奏" 字符重合)
             total ≈ 0.017
```

**lexical rerank 在 semantic 错位 + 字面信号强的边缘 case 上是有效的 tiebreaker**——这就是 hybrid 比 semantic 提升 16.7pp 的核心机制。

### 8.3 prompts 溯源约束跨场景污染

第六部分已经详细讲了。重点提炼:**任何 prompt 改动都要复测全场景**,不能只测"我想加这条规则的目标场景"。`outputFormat` 加溯源是为了正式回答场景,但模型把它溢出到反问场景——这是 prompt 工程的常见污染模式,根因跟 note-02 §5 的"Few-shot 被当真实历史"是同一类问题(**模型缺乏精确的 context boundary**)。

### 8.4 间接注入防御代码就位但未触发

阶段3 顺手补完了 RAG 检索 chunk 的 `detectInjection`,在 `semantic_search_travel` 工具里:

- ✅ 代码就位:每条返回 chunk 都走检测,命中则 `wrapUntrusted`
- ⚠️ 当前未触发:自家 seed 数据无注入,11 条 inj-* case 也是用户消息层,不走 RAG

**真正的考验在阶段3.7**:接入 Tavily 联网搜索后,Web 检索回来的网页可能含 prompt injection——这套防御立即生效。**预防式编程的典型**:坑在阶段2 §5.6 看见,阶段3 顺手挖好沟,阶段3.7 真攻击来了直接生效。

### 8.5 STAR 故事提炼

> **S(背景)**:阶段3 接入 RAG 后,跑混合检索评测发现 `q2 推荐吃辣的地方` 所有策略都没选成都,而 `q5 古城慢节奏` 被 hybrid 从错位的哈尔滨拉回了丽江。
>
> **T(任务)**:解释"为什么 hybrid 救回 q5 救不回 q2",沉淀决策。
>
> **A(行动)**:看 chunk text + 距离数据发现根因——deterministic embedder 用字符 n-gram 哈希,**"古城" 在 query 和"丽江古城" chunk 里都有字符重合,lexical rerank 把丽江拉回 Top-1**;但 "辣" 在成都美食 chunks 里根本不出现("火锅"/"麻辣"/"串串"),字面 + 字符级语义双失败,只能等真 embedder。**修复方案**:这不是 hybrid 设计的问题,是 embedder 选型的下限——我把切真 embedder 的接口和文档都备好了,改 1 行 .env + 1 条命令搞定。
>
> **R(结果)**:① hybrid 在 deterministic 下 Top-1 提升 +16.7pp 有了根因解释;② 沉淀了"embedder 局限 + 升级路径明确"的工程决策(`docs/02-实验记录/exp-04-hybrid-vs-pure.md`);③ 顺带证明了 Embedder 接口抽象的有效性——切 provider 业务代码 0 改动。

---

## 第九部分:自测题(进入阶段4 前请确认能答上)

> 使用建议:每道题先盖住答案、用自己的话默答一遍,再展开比对。

### Chunk 与 Embedder

**1. 为什么我们项目不做 chunk overlap?**

> **答**:overlap 适合长文档(避免一句话被切断),我们的数据是结构化条目(每条 feature 独立),overlap 反而把不同主题混到一起,引入噪声。

**2. chunk text 为什么要拼"目的地名 + 类别"前缀?**

> **答**:模型只看 chunk text(没行号、没表名),光"雪山景观突出..." 它不知道"哪儿的雪山";拼"丽江的美景「玉龙雪山」:..." 让 chunk **自我描述完整**。

**3. Embedder 为什么必须抽象成接口?**

> **答**:实施时 MiniMax 账号无 embedding 权限,如果硬编码会卡在 RAG 第一步。抽象后 3 个实现(minimax/openai/deterministic)按 .env 切换,业务代码 0 改动——所有外部依赖都该先做抽象层,你永远不知道哪个 provider 会卡你。

**4. DeterministicEmbedder 的根本局限是什么?用一个实测 case 证明。**

> **答**:它是字符 n-gram 哈希,不"理解"语义,只看字面重合。**q2 "推荐一个吃辣的地方"**:成都美食 chunks 里写的是"火锅"/"麻辣"/"串串",字符跟"辣"完全无关 → 所有策略都没选成都。换真 embedder 大概率修复。

### Chroma 与 VectorStore

**5. 为什么选 Chroma 而不是 MySQL JSON 列 或 Milvus?**

> **答**:三档取舍:① MySQL JSON 列**无索引玩具感强**;② Milvus 运维**太重不匹配几百向量规模**;③ Chroma **docker 一键起 + HNSW 内置 + LangChain 生态**——学习项目甜蜜点。VectorStore 抽象层留 Milvus 切换口。

**6. "两层架构"(MySQL = 真理,Chroma = 索引衍生物)的工程含义是什么?**

> **答**:① 改 seed 必须 `npm run index` 重灌(数据不会自动同步);② Chroma 挂了重跑 `npm run index` 完整恢复无业务损失;③ 升级 embedder 必须全量重灌(维度变了)。**别把检索索引当真理,真理永远在原始数据。**

**7. Chroma 的 EmbeddingFunction 机制是怎样的?**

> **答**:把"文本→向量"算法注入 collection,`add` 时只传 `documents`(不预先算 embedding),Chroma 自动调 `embeddingFunction.generate()`。我们把项目的 `Embedder` 接口包装成 chromadb 要求的 `EmbeddingFunction`(两个 generate 方法签名一致,几行 wrapper)。

### 工具与 ReAct 协作

**8. 怎么让 LLM 知道"何时调 semantic_search_travel"?**

> **答**:**双重加固**——① 工具 description 写"模糊或难以用关键词表达时优先";② system prompt `toolUsageRules` 再加一条规则。降低模型选错工具的概率。这就是 function calling 的核心机制。

**9. semantic_search_travel 跟 search_destinations / get_destination_detail 是替代关系吗?**

> **答**:**互补不替代**。SQL 工具回答"用户能说出明确词的问题",RAG 回答"用户只能说出感觉的问题"。`sem-01` 实测显示模型会**先 RAG 兜底找方向,再 SQL 拿精确事实**——完美的"RAG + SQL"协作。

**10. RAG 检索回来的 chunk 为什么也要走 detectInjection?**

> **答**:间接注入防御——网页/文档/被污染的数据库可能含 prompt injection,一旦拼进上下文模型可能被骗着执行。当前 self-seed 数据安全,但代码已就位,等 Task 3.7 接 Tavily 联网搜索时立即生效(预防式编程)。

### 混合检索

**11. RRF 为什么比"分数线性加权"好?**

> **答**:RRF 用 rank 不用分数,**不需要归一化两路分数的尺度**(keyword BM25 分跟 cosine 距离根本不在一个量纲);工业默认 k=60 开箱即用;一路返回空也无副作用。线性加权要调 w1/w2 + 处理一路空的退化。

**12. hybrid 在 deterministic 下能提升 +16.7pp,真 embedder 下还能提升吗?**

> **答**:**预期提升幅度会变小**——真 embedder 越准,lexical rerank 边际价值越低。但通常仍有提升,因为 lexical 信号(用户字面 query)是**额外的独立维度**。如果真 embedder 下 hybrid 不再优于 semantic,可以降 lexical 权重(0.3→0.1)或换 cross-encoder rerank。

**13. 为什么 hybrid 不暴露为 LLM 可调用的 tool?**

> **答**:让模型选 strategy 是设计失败——模型不应该懂"什么时候用 hybrid"。工具语义应当**对模型透明**:`semantic_search_travel` 就叫"语义检索",hybrid 是底层实现细节。hybrid 仅供评测脚本和未来 toolAgent(Task 5.1)使用。

### 溯源

**14. RUN_FINISHED.sources 字段是怎么收集的?**

> **答**:① 三个工具的 `ToolRunResult` 都填 sources;② `runAgentStream` 用 `sourceMap` 跨多轮去重(同 destinationId 保留首次的 via);③ 最终 `createRunFinished(..., Array.from(sourceMap.values()))` 挂到事件。前端从 `RUN_FINISHED.sources` 渲染"信息来源"标签。

**15. v1_base.outputFormat 加溯源约束时踩过什么坑?**

> **答**:**跨场景污染**——加完 outputFormat 后 ask 类 case fail,模型把 `[ASK_USER]` 反问场景的 `【选项】` 改成了 `【出行时间】`/`【同行人员】` 分类标题,破坏了 `parseAskUser` 字面契约。修复:溯源规则加"反问场景豁免"。**任何 prompt 改动都要复测全场景**,不能只测目标场景。

### 综合

**16. 阶段3 学到的东西怎么映射到八股 03 章节?**

> **答**:① §2 切分策略 → Task 3.1 不做 overlap + 带前缀;② §3 向量化 → Task 3.1 Embedder 多 provider;③ §3.2 向量存储 → Task 3.2 Chroma 选型 + VectorStore 抽象;④ §5 混合检索 → Task 3.4 RRF + lexical rerank(+16.7pp 实证);⑤ §6 重排序 → lexical 是 cross-encoder 的轻量替代;⑥ §7 溯源 → Task 3.5 Source 类型 + sources 字段。**面试反过来讲**:从八股切入,讲我们项目的实现 + 踩坑 + 实测数据。

**17. 进入阶段4 之前,RAG 体系还有哪些隐忧?**

> **答**:三个:① **embedding 走 deterministic,真语义召回未验证**——切真 provider 是一行 .env 但还没做;② **测试集只 6 条 query**,扩到 30+ 才稳;③ **Source 未在前端 UI 渲染**——后端契约已就位,等任意 web 迭代任务补上。Task 3.6 + 3.7 + 3.5 sources UI 把这些隐忧扫干净后,阶段4 的多 Agent / MCP 故事才更完整。

> **延伸练习**:把这 17 道当首轮筛子,**仍然答不顺**的题翻 `docs/01-面试八股文/03-RAG技术.md` 精读对应章节。重点是 Q4 / Q6 / Q11 / Q15 这 4 题——它们是阶段3 真正的"工程深度"。

---

## 第十部分:进入阶段4 前的准备

阶段4 是 **Agent 核心**——ReAct 增强 / Plan-and-Execute / 记忆分层 / MCP+Skills / Run 持久化 / LangGraph 对照。本笔记的 RAG 体系是阶段4 的**前置基础**:

| 阶段4 任务 | 用到的 RAG 能力 |
|----------|---------------|
| 4.1 增强 ReAct + trace | RAG 工具调用是 ReAct 多轮链路的核心场景 |
| 4.2 Plan-and-Execute | 复杂查询(7 天云南游)会把 RAG 拆成多步:语义检索→分类详情→整合 |
| 4.3 记忆分层 | 用户偏好摘要 + RAG 检索一起注入 prompt |
| 4.4 MCP + Skills | `semantic_search_travel` 会被改成 MCP Server;旅游推荐 Skill 组合 RAG + SQL + web_search |
| 4.5 Run 持久化 | 中途 RAG 工具调用结果要 checkpoint(等阶段4 真做) |
| 4.6 LangGraph 对照 | LangGraph 也能挂 Chroma,对比手写工具与 langchain VectorStoreRetriever |

带着这些视角进阶段4,你会发现阶段3 的每个抽象层(Embedder / VectorStore / 工具暴露)都在为后面铺路。

---

## 第十一部分:延伸阅读路线

1. **入门视频**:Chroma 官方 quickstart(15 分钟)、LangChain RAG 教程
2. **八股系统化**:`docs/01-面试八股文/03-RAG技术.md` 通读一遍
3. **论文经典**:Lewis et al. 2020《RAG: Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks》(原始 RAG 论文)
4. **进阶**:
   - HyDE(Hypothetical Document Embeddings):用 LLM 先生成假答案再 embed,提升召回
   - GraphRAG:Microsoft 2024,把知识库变成图谱再检索
   - Self-RAG:模型自己判断"要不要检索 / 检索质量够不够",对应高阶 Agent 决策
5. **工具实战**:把 `EMBEDDING_PROVIDER` 切到真 embedder 重跑 `npm run eval:rag`,直观感受语义召回差异

---

## 收束

学完这篇,你应该能:

- ✅ 用自己的话讲清楚 RAG 是什么、为什么需要、跟 LLM 单靠自身的差异
- ✅ 知道 Chunk 切分的策略、Embedder 抽象的必要性、Chroma 选型的取舍
- ✅ 能解释 `semantic_search_travel` 工具如何被 LLM 选中、ReAct 多轮如何串联 RAG + SQL
- ✅ 能讲清楚 RRF 比线性加权好在哪、hybrid +16.7pp 的根因
- ✅ 能用 STAR 结构讲"deterministic 局限暴露" + "古城慢节奏被 hybrid 救回" + "溯源约束跨场景污染" 三个故事
- ✅ 看 `docs/01-面试八股文/03-RAG技术.md` 不再吃力——本笔记是它的"工程化解读 + 实战踩坑版"

**你现在已经具备了进入阶段4 Agent 核心的全部前置知识 + 一组可以拿出去面试的真实工程故事**。

---

## 附录:本笔记涉及的代码位置速查

| 概念 | 代码位置 |
|------|---------|
| Chunk / SearchResult 类型 | `src/rag/types.ts` |
| 切分逻辑 | `src/rag/chunker.ts:buildAllChunks` |
| Embedder 接口 + 3 实现 | `src/rag/embedder.ts` |
| Embedder 工厂 | `src/rag/embedder.ts:createEmbedder` |
| VectorStore 接口 + Chroma 实现 | `src/rag/vectorStore.ts` |
| 灌数据脚本 | `scripts/index-vectors.ts` |
| semantic_search_travel 工具 | `src/agent/tools.ts(definitions + runTool 分支)` |
| 间接注入防御接入点 | `src/agent/tools.ts:runTool('semantic_search_travel')` |
| 混合检索 + RRF | `src/rag/hybridSearch.ts` |
| 三策略评测脚本 | `scripts/eval-rag.ts` |
| Source 类型 + RunFinishedEvent.sources | `src/agent/ag-ui.ts` |
| sources 跨多轮聚合 | `src/agent/llm.ts(sourceMap)` |
| 溯源 prompt 约束 + 反问豁免 | `src/agent/prompts/v1_base.ts:outputFormat` |
| Chroma docker 服务 | `docker-compose.yml(chroma service)` |
| RAG 相关配置 | `src/config.ts(CHROMA_* / EMBEDDING_*)` |
| 实验报告 | `docs/02-实验记录/exp-04-hybrid-vs-pure.md` + JSON |
| 架构文档 RAG 部分 | `docs/04-架构文档/agent-架构.md §1.1 / §3.6 / §4.4 / §5.7-5.8`(待补,Task 同步) |

---

> **写在最后**:这篇笔记的核心价值不在"讲清楚 RAG 是什么"(八股能讲),而在**真实工程权衡 + 实测踩坑**——Embedder 抽象救了我们一次(MiniMax 无权限)、hybrid 救了 q5 但没救 q2(deterministic 局限)、溯源约束意外破坏 ASK_USER 协议——这些都是项目里真的发生过的事,值得反复打磨成 2 分钟级别的精炼版本。**面试官想听的不是"我懂 RAG 概念",而是"我把 RAG 落地时踩过什么坑,怎么修的"**。
