# 实验 02:Prompt 版本对比与迭代(v1_base vs v2_cot)

> 关联:`docs/开发规划.md` Task 2.3 评测框架;`docs/01-面试八股文/09-Prompt工程.md` §2.4 迭代优化、§3.5 Few-shot 注入形式、§4.2/§4.5 Zero-shot CoT。
>
> 目的:用 11 条覆盖 6 类典型场景的测试集,对比 v1_base(标准版)与 v2_cot(CoT 增强版)在工具调用准确性、反问触发率、关键词命中率上的差异;通过 2 轮迭代验证 prompt 改动的实际效果,作为 Task 2.3 的核心交付。

---

## 实验设置

| 项 | 值 |
|---|---|
| 模型 | MiniMax-M2.7(`.env` 配置) |
| 温度 | `LLM_TEMPERATURE=0.4` |
| top_p | 1 |
| 测试集 | `src/eval/testset.ts`(11 条 × 6 类:ask_user / keyword_search / detail_list / semantic_search / context_followup / free_form) |
| 评测器 | `scripts/eval-prompt.ts`(规则判定 MVP) |
| 判定维度 | 工具命中(`tool`)、关键词命中(`keywords`)、是否反问(`clarification`)— 任一非 null 维度失败则整体 fail |
| 单 case 间隔 | 1.5 s(避免 rate limit) |
| 评测路径 | 复用 `runAgentStream`,绕过 HTTP/AG-UI/`chat_messages` 落库,工具仍走真实 MySQL pool |

---

## 第 1 轮:基线对比

| 版本 | pass | fail | hardFailRate |
|---|---|---|---|
| v1_base | 9/11 | 2 | 18.2% |
| **v2_cot** | **11/11** | **0** | **0.0%** |

> 原始数据:`exp-02-prompt-versions-2026-05-28T14-09-25-113Z.json`

### 关键发现 1:v1_base 在 ask 类反问场景失败

`ask-01`("推荐个地方")/`ask-02`("我想出去玩,有什么推荐?")应触发 `[ASK_USER]` 反问,v1_base 都没反问。MiniMax 模型的 `<think>` 标签直接暴露了原因:

> "用户突然又让我推荐地方,**上下文已经有关于上海出发、3 天、自然风光的偏好**,我可以直接基于这个偏好给出推荐,不需要再问。"

**根因**:Few-shot 示例以 user/assistant 消息形式 prepend,模型把示例 2("我从上海出发、3 天、自然风光")当成了**真实历史**,直接复用。这是八股 09 §3.5 推荐"messages 形式 Few-shot"的隐性陷阱——带 `<think>` 的模型在思考阶段会"翻看历史",难以区分示例与真实输入。

### 关键发现 2:v2_cot 的 CoT 指令意外修复了污染问题

v2_cot 在 `ask-01/02` 都正确反问。看 v2_cot 的 `cotInstruction` 第 3 步:

> "当前信息是否足够给出有效建议——若不足,先按反问规则发起 `[ASK_USER]`。"

CoT 强制模型重新评估"当前信息充分性",**绕过了**对 Few-shot 历史的盲目复用。这是 CoT 在 Agent 场景的一个未预期收益——它不仅做"分步推理",还能在多源上下文里强制"以当前为锚"。

---

## 第 2 轮:基于发现迭代 v1_base

### 改动

在 `v1_base.taskScope` 增加防污染说明(commit:`src/agent/prompts/v1_base.ts`):

> "接下来你会看到若干 user/assistant 对话:其中**开头几轮可能是教学示例**,真正需要你回应的用户消息以**最末一条 user 消息**为准——不要把示例里的偏好或上下文当作当前用户的偏好。"

### 结果

| 版本 | pass | fail | hardFailRate | 备注 |
|---|---|---|---|---|
| v1_base | 9/11 | 2 | 18.2% | ask-01/02 由 fail → pass(taskScope 修复有效);但 free-02/03 因服务端超时变 fail |
| v2_cot | 5/11 | 6 | 54.5% | 大量 `tokens=0` 长超时,**主要是上游服务不稳定** |

> 原始数据:`exp-02-prompt-versions-2026-05-28T17-44-36-951Z.json`

### 关键发现 3:taskScope 防污染说明对 ask 类有效

v1_base 在 `ask-01/02` 由 fail 变 pass,验证了第 1 轮的根因诊断:Few-shot 污染可以靠"明确的 system 边界"缓解,**不一定要换注入形式**(messages 形式仍可保留,八股 09 §3.5 推荐没问题)。

### 关键发现 4:LLM 服务稳定性是评测的硬约束

第 2 轮多个 case 出现 `tokens=0` + `durationMs > 900 s` 的异常:

| case | durationMs | text 末态 |
|---|---|---|
| `v1_base/free-02` | 939,623 | `<think>`(只有 think tag) |
| `v1_base/free-03` | 1,287,625 | `<think>` |
| `v2_cot/ask-01` | 2,026,938 | `<think>用户没有提供足够的信息...` |
| `v2_cot/free-02` | 1,934,331 | (空) |
| `v2_cot/free-03` | 2,027,002 | `<think>用户问的是...` |

这些**不是 prompt 设计失败**,是 MiniMax 服务端在长时间跑批后出现的不稳定(可能是限流,也可能是模型内部 think 阶段循环)。**单次评测不能定论**——同样的 prompt 在两轮跑出截然不同的结果,且第 2 轮 `LLM_REQUEST_TIMEOUT_MS=60_000` 的超时也没在所有 case 生效(疑似上游连接保活但不下发数据)。

---

## 结论

### 站得住的结论(基于第 1 轮 + 第 2 轮 ask 类的稳定信号)
1. **CoT 在 Agent + Few-shot 场景下,价值不只是"推理过程"**:它能强制"以当前为锚",规避历史污染——v2_cot 第 1 轮 11/11 的关键功臣。
2. **Few-shot messages 形式的污染可以靠 system 边界声明缓解**:不必牺牲 §3.5 推荐的注入形式;v1_base 第 2 轮 ask 类修复证明了这点。
3. **规则判定 MVP 够用但有盲区**:能查"工具是否调对、关键词是否命中、是否反问",但抓不到"答非所问、风格漂移、幻觉"。

### 暂不能下定论的(需要更稳定的环境)
- v2_cot vs v1_base(已加 taskScope)的真实差距:第 2 轮服务异常掩盖了 prompt 信号
- free_form 类 case 的关键词命中率波动:需要多次跑取均值

---

## 后续迭代方向

| 改进点 | 落点 | 关联阶段 |
|---|---|---|
| 单 case 失败后重试 1~2 次 | `scripts/eval-prompt.ts` 加 retry | 阶段5 Task 5.3 |
| 每个 case 跑 N 次取多数派 | `runner.ts` 增加 `repeats` 参数 | 阶段5 Task 5.3 |
| LLM-as-judge 评判 free-form 类语义 | 新增 `src/eval/grader-llm.ts` | 阶段5 Task 5.5 网关层 |
| `LLM_REQUEST_TIMEOUT_MS` 应同时盯流空闲(stream-idle timeout) | `src/agent/llm.ts:postChatStream` | 阶段5 Task 5.3 |
| 测试集扩到 30 条 + 标注难度 | `src/eval/testset.ts` | 本任务可继续 |

---

## 复现步骤

```bash
# 1. 启动 + 准备数据
docker compose up -d
npx tsx scripts/migrate.ts
npx tsx scripts/seed.ts

# 2. 跑评测
npx tsx scripts/eval-prompt.ts                    # 全集 = 全部已注册版本 × 11 case
npx tsx scripts/eval-prompt.ts --case ask-01      # 单 case 调试
npx tsx scripts/eval-prompt.ts --version v1_base  # 单版本

# 3. 查看报告
ls docs/02-实验记录/exp-02-prompt-versions-*.json
```

---

## 八股呼应
- **09-Prompt工程.md §2.4 迭代优化**:本实验是"评测 → 发现 → 改进 → 复验"四步的最朴素形态。
- **09-Prompt工程.md §3.5 Few-shot 注入形式**:发现 messages 形式的污染陷阱,补全八股的"风险面"叙事——并给出"system 边界声明"的低成本修复方案。
- **09-Prompt工程.md §4.2 Zero-shot CoT / §4.5 Agent 中的 CoT**:观察到 CoT 在多源上下文下"强制以当前为锚"的副作用,扩展了 §4.5 的应用场景。
- **08-工程化实践.md §7 评估与测试**:LLM 评测的稳定性挑战(第 2 轮上游异常)是工程化必谈点;为阶段5 Task 5.3/5.5 的容错与网关层留下了真实的"项目内事故"作为 STAR 故事素材。
