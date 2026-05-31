# 实验 04:RAG 检索策略对比(keyword vs semantic vs hybrid)

> 关联:`docs/开发规划.md` Task 3.4 混合检索与重排序;`docs/01-面试八股文/03-RAG技术.md` §5 混合检索 / §6 重排序;`docs/03-开发笔记/note-02 §5.6` 注入防御的 RAG 衔接。
>
> 目的:验证 **RRF (Reciprocal Rank Fusion) + lexical rerank** 的混合检索是否比单路 keyword/semantic 召回更准;沉淀 hybrid 真正帮上忙的边缘 case,作为面试 STAR 素材。

---

## 实验设置

| 项 | 值 |
|---|---|
| 数据规模 | 18 chunks(3 个目的地 × {summary 1 + features 5}) |
| Embedder | `deterministic`(字符 n-gram 哈希,128 维,完全离线) |
| 向量库 | Chroma 3.x,HNSW + cosine |
| 召回参数 | TopK=3,each-strategy recallN=6 |
| 评测 query | 6 条(覆盖语义/字面/复合需求) |
| 判定 | top-1 hit 与 top-K hit;基于"期望命中的 destinationName" |

**关键限制**:`deterministic` embedder 的"语义"相似度是字符 n-gram 重合,**并不反映真实语义**——所以本实验主要验证"混合机制本身能否提升",绝对准确率换真 embedder 后会大变。

---

## 第 1 轮结果

| 策略 | Top-1 召回率 | Top-K 召回率 |
|------|------------|------------|
| keyword | 0/6 (0.0%) | 0/6 (0.0%) |
| semantic | 4/6 (66.7%) | 5/6 (83.3%) |
| **hybrid** | **5/6 (83.3%)** | **5/6 (83.3%)** |

> 原始数据:`exp-04-hybrid-vs-pure-2026-05-30T14-20-24-606Z.json`

### 三个观察点

#### 1. keyword 单路 0% 是预期,不是 bug

我们的 query 大量用"感觉描述"("想看雪山但不想太累"、"古城慢节奏"、"欧式风情"),这些词**不直接出现在 destinations.summary 字段里**。SQL LIKE 找不到任何匹配——这恰恰说明**为什么需要语义检索作为 keyword 的补集**。

#### 2. semantic 单路 Top-1 67% 错了 2 条,谁?

- **q2 "推荐一个吃辣的地方"**:semantic 选了"哈尔滨"(应为成都);hybrid 也没救回来。根因:`deterministic` 的字符 n-gram 不知道"辣"和"火锅"语义相关——这就是 deterministic embedder 的根本局限,换真 embedder 后大概率修复。
- **q5 "古城慢节奏"**:semantic 选了"哈尔滨"(应为丽江);**hybrid 救回来了**(下文详述)。

#### 3. hybrid 比 semantic 提升 +16.7%,功劳是 lexical rerank

看 q5 详细对比:

```
semantic: 哈尔滨[0.284] 丽江[0.277] 丽江[0.235]   ← Top-1 错位
hybrid  : 丽江[0.154]   哈尔滨[0.017]              ← Top-1 修正
```

原因:hybrid 的 score 公式是 `RRF + 0.3 * lexicalOverlap(query, text)`。query "古城慢节奏" 与"丽江古城"的字符 2-gram 重合度高(命中"古城"),`lexicalOverlap` 加成把丽江从 #2 拉到 #1。

**这是混合检索的核心价值**:语义相近时,lexical 信号是有效的 tiebreaker。

---

## 关键设计决策

### 决策 1:RRF 而不是分数线性加权

```ts
// RRF: score = Σ 1/(60 + rank_i)
// vs 线性: score = w1 * keyword_score + w2 * semantic_score
```

| RRF | 线性加权 |
|-----|---------|
| 不关心两路分数的"绝对值",只用 rank | 需要先归一化 keyword/semantic 分数到同一尺度 |
| 工业默认 k=60 即用即跑 | 权重 w1/w2 要按数据调参 |
| 即使一路返回空也无副作用 | 一路返回空时另一路被错放大 |

**结论**:RRF 是检索融合的 sane default,本项目甜蜜点。

### 决策 2:rerank 用 lexical overlap,不上 cross-encoder

`docs/开发规划.md` 原文允许"简单 rerank"(查询词与文本重合度)或 cross-encoder。我们选前者:
- **零额外依赖**(纯 JS),无 model load 开销
- **可解释**:面试能讲清楚 score 怎么算
- **生产升级路径明确**:换 cross-encoder(如 `bge-reranker-base`)只改 `lexicalOverlapBoost` 函数,接口不变

### 决策 3:混合不作为新 tool 暴露

`semantic_search_travel` 工具内部走纯语义,**hybrid 仅供评测脚本和未来的 toolAgent 使用**——避免给 LLM "选择困难":让模型选 keyword/semantic/hybrid 一定是设计失败,工具语义应当对模型透明。

---

## 切到真 embedder 后该看什么

切换 `EMBEDDING_PROVIDER` 到 `openai` 或 `minimax` 后,**重跑本评测**应观察:
1. **semantic Top-1 是否能修复 q2 "辣→火锅" 的语义鸿沟**(预期是,毕竟真 embedding 理解概念关系)
2. **hybrid 相对 semantic 的提升是否还在**(预期是,但提升幅度可能变小——真 semantic 越准,rerank 边际价值越低)
3. **q5 "古城慢节奏" 是否仍需 lexical rerank 修正**(预期 lexical 仍能提供额外信号,但靠 semantic 单路也可能足够)

如果出现 "真 embedder 下 hybrid 不再优于 semantic",可能需要:① 降低 lexical 权重(0.3 → 0.1);② 引入 cross-encoder 重排做更精细的 tiebreaker。

---

## 复现步骤

```bash
docker compose up -d                  # MySQL + Chroma 都要起
npx tsx scripts/migrate.ts && npx tsx scripts/seed.ts
npm run index                         # 灌向量
npm run eval:rag                      # 跑 6 query × 3 strategy
```

---

## 八股呼应

- **03-RAG技术.md §5 混合检索**:实战版的 RRF 实现 + 数据印证"hybrid > 单路"。
- **03-RAG技术.md §6 重排序**:展示了 lexical rerank 作为 cross-encoder 的轻量替代,并讲清楚了升级路径。
- **08-工程化实践.md §4 多策略对比**:用同一接口跑 keyword/semantic/hybrid 的对照实验是工程化的正确姿势(避免代码漂移)。

---

## 一句话总结

> **deterministic embedder 下,RRF + lexical rerank 的 hybrid 检索比纯 semantic 在 Top-1 上提升 +16.7%——关键功臣是 q5 "古城慢节奏" 通过 lexical 重排把丽江从 Top-2 拉到 Top-1。** 换真 embedder 后召回率会整体上涨,但混合 vs 单路的方法论结论不变。
