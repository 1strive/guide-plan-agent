# 阶段4 开发笔记:Agent 核心(代码改动速查)

> **本文目标**:把 `docs/开发规划.md` 阶段4 已落地任务的**每一处代码改动**记录清楚,方便下次接手 / 回看 / 排错时直接跳到对应文件,不用逆向猜实现。
>
> 不讲原理(原理见 `docs/01-面试八股文/02-核心框架.md`),不讲 STAR 故事(参见对比实验 `docs/02-实验记录/exp-05-plan-vs-react-*.json`),只列"做了什么、改了哪、为什么"。
>
> **配套文档**:架构总图 `docs/04-架构文档/agent-架构.md` §1.2 / §3 / §4.2 / §6;实验数据 `exp-05`。
>
> **覆盖范围**:Task 4.1(增强 ReAct + 可观测性)✅、Task 4.2(Plan-and-Execute 模式对比)✅、Task 4.3(记忆分层)✅、Task 4.4(MCP + Skills)✅。

---

## 总览

| Task | 一句话 | 新增文件 | 改动文件 |
|------|--------|----------|---------|
| **4.1.A** | `<think>` 标签流式切分(MiniMax content 内联 reasoning 拆分) | `src/agent/thinkSplit.ts` | `src/agent/ag-ui.ts` `src/agent/langgraphToAgUi.ts` |
| **4.1.B** | trace_id 贯穿 pino log + 工具调用 timing 日志 | — | `src/index.ts` `src/agent/runManager.ts` `src/agent/langgraphToAgUi.ts` `src/agent/langgraph-agent.ts` |
| **4.1.C** | `computeCostUsd` + finalize `'run summary'` 索引日志 | — | `src/agent/token-usage.ts` `src/agent/runManager.ts` |
| **4.1.D** | 前端「思考过程」折叠区 | — | `web/src/App.tsx` |
| **4.2.A** | `export buildChatModel` + `PLAN_GENERATED` AG-UI 事件 | — | `src/agent/langgraph-agent.ts` `src/agent/ag-ui.ts` |
| **4.2.B** | Plan-and-Execute Agent 三阶段实现 | `src/agent/planner.ts` | — |
| **4.2.C** | `?mode=react\|plan` body 参数 + runManager dispatch | — | `src/index.ts` `src/agent/runManager.ts` |
| **4.2.D** | 评测扩展 mode 维度 + 对比实验脚本 | `scripts/eval-plan-vs-react.ts` | `src/eval/runner.ts` `package.json` |
| **4.3** | 记忆分层:对话摘要 + prompt 注入 | `src/agent/memory.ts` `src/db/migrations/005_session_summary.sql` | `src/db/chatRepo.ts` `src/agent/runManager.ts` `src/agent/prompts/*` `src/index.ts` |
| **4.4** | MCP 接入 + Skills + 删除本地 SQL 工具 | `src/mcp/client.ts` `src/skills/**` | `src/agent/langgraph-agent.ts` `src/agent/planner.ts` `src/agent/ag-ui.ts` `src/eval/*` `package.json` |

事件类型新增 4 个:`THINKING_START / CONTENT / END`(Task 4.1) + `PLAN_GENERATED`(Task 4.2);AG-UI 事件总数 12 → 16。

---

## Task 4.1:增强 ReAct + 可观测性

### 4.1.A 新增 `src/agent/thinkSplit.ts`(151 行)

跨 chunk `<think>...</think>` 状态机切分。**纯函数 + 显式 state**,可单测、可被 planner 复用。

**核心数据**:
```ts
export type ThinkSplitState = { mode: 'text' | 'think'; tail: string }
export type ThinkSegment = { kind: 'text'; value: string } | { kind: 'think'; value: string }

export function feedThinkSplit(state, chunk): { segments, state }
export function flushThinkSplit(state): { segments, state }
```

**关键代码片段**(`thinkSplit.ts:feedThinkSplit`):
```ts
while (buf.length > 0) {
  if (mode === 'text') {
    const openIdx = buf.indexOf('<think>')
    if (openIdx === -1) {
      // 末尾可能是 '<th' 这种"疑似标签前缀",留 tail
      const cut = trailingPartialTag(buf, '<think>')
      if (cut > 0) emitText(segments, buf.slice(0, cut))
      buf = buf.slice(cut)
      break
    }
    if (openIdx > 0) emitText(segments, buf.slice(0, openIdx))
    buf = buf.slice(openIdx + '<think>'.length)
    mode = 'think'
  } else {
    // think 内同理找 </think>
    ...
  }
}
```

**4 种边界**(单测全过 11 条):
1. 完整 `<think>X</think>`
2. 起始跨 chunk `<th|ink>`
3. think 内部跨 chunk `<think>part1|part2</think>`
4. 闭合跨 chunk `</thi|nk>`
5. 加 6 个变体:纯文本 / 全 think / 未闭合 / 多个 think 交错 / 字符级流 / 紧贴两个 think

**关键设计**:不在 `emit` 里合并同 kind segment,避免"中间经过 mode 切换但 mid-segment 因空字符串跳过 emit → 后续被错误合并"(实测 ⑪ 紧贴两个 think 暴露的 bug)。

### 4.1.A 改 `src/agent/ag-ui.ts`(加 3 个事件类型)

```ts
THINKING_START / THINKING_CONTENT / THINKING_END  // 跟 TEXT_MESSAGE_* 平行
```

事件构造器命名沿用 `createThinking*` 模式;`AgUiEvent` union 加 3 个分支。前端 `App.tsx:consumeStream` switch 无 default,加新类型不破坏。

### 4.1.A 改 `src/agent/langgraphToAgUi.ts:translateLangGraphStream`(adapter 双通道)

```ts
case 'on_chat_model_stream': {
  // 通道 1:DeepSeek/xAI/OpenRouter 走 additional_kwargs.reasoning_content
  const reasoning = chunk?.additional_kwargs?.reasoning_content ??
                    (chunk as { reasoning_content?: string })?.reasoning_content ?? null
  if (reasoning) { ...yield THINKING_*... }

  // 通道 2:MiniMax 把 <think>...</think> 内联到 content
  const content = typeof chunk?.content === 'string' ? chunk.content : ''
  if (content) {
    const { segments, state } = feedThinkSplit(thinkSplitState, content)
    thinkSplitState = state
    for (const seg of segments) {
      if (seg.kind === 'think') yield createThinkingContent(...)
      else { yield createTextMessageContent(...); fullContent += seg.value }
    }
  }
}
```

**重要不变量**:`fullContent`(用于流末 `parseAskUser`)只累加非 think 段。否则 think 内的 `[ASK_USER]` 会被误判。

### 4.1.B trace_id 贯穿 + 工具 timing

**`src/agent/runManager.ts`**:start 时 child logger 绑 runId,RunHandle 持 log,所有日志行自动带 runId:
```ts
const log: FastifyBaseLogger = (parentLog ?? this.log).child({ runId, mode })
const handle: RunHandle = { ..., log, startedAt: Date.now(), toolStats: { count: 0, names: [] } }
```

**`src/agent/langgraphToAgUi.ts`**:`Ctx` 加 `log?: AdapterLogger`;`on_tool_start` 记 startedAt,`on_tool_end` 算 duration + log:
```ts
const toolStart = new Map<string, { name, startedAt, argsPreview }>()
// on_tool_start
toolStart.set(toolCallId, { name, startedAt: Date.now(), argsPreview })
// on_tool_end
const started = toolStart.get(toolCallId)
ctx.log?.info({
  tool: started.name, toolCallId,
  durationMs: Date.now() - started.startedAt,
  argsPreview: started.argsPreview,
  resultPreview: ... // 截 200 字符防爆日志
}, 'tool finished')
```

**真实日志样例**(`logs/app.log` Task 4.1 第一次验证):
```json
{"level":30,"runId":"0cacd05c-...","tool":"get_destination_detail","toolCallId":"019e83ad-...",
 "durationMs":14,"argsPreview":"{\"destination_id\":2}",
 "resultPreview":"{\"error\":\"destination not found\",\"destination_id\":2}","msg":"tool finished"}
```

### 4.1.C cost 计算 + run summary

**`src/agent/token-usage.ts:computeCostUsd`**:
```ts
export function computeCostUsd(usage: TokenUsage, config: AppConfig): number {
  return (usage.promptTokens / 1000) * config.MODEL_PRICE_INPUT_PER_1K
       + (usage.completionTokens / 1000) * config.MODEL_PRICE_OUTPUT_PER_1K
}
```

**`runManager.finalize`**:每个 Run 末尾一行**"trace 索引日志"**,grep runId 即可拿全链路:
```ts
handle.log.info({
  status, mode: handle.mode, durationMs,
  totalTokens, promptTokens, completionTokens,
  costUsd: Number(costUsd.toFixed(6)),
  toolStats: handle.toolStats  // { count, names: [...] }
}, 'run summary')
```

**真实样例**:
```json
{"runId":"0cacd05c-...","status":"completed","mode":"react","durationMs":5829,
 "totalTokens":7358,"costUsd":0,
 "toolStats":{"count":3,"names":["get_destination_detail","search_destinations","get_destination_detail"]},
 "msg":"run summary"}
```

### 4.1.D 前端 thinking UI

**`web/src/App.tsx`** 3 处改动:
1. `ChatMsg` 加 `thinking?: string`
2. `consumeStream` switch 加 case:
   ```tsx
   case "THINKING_CONTENT": {
     ensureAssistantStub()
     assistantThinking += event.delta as string
     updateLastAssistant()
     break
   }
   ```
3. 渲染加 `<details>` 折叠区(默认收起,纯 inline style 跟现有极简风格一致)。

### 4.1 实测红利:`inj-01` 副带修复

Task 4.1 前的失败 case:`inj-01` 的 text 是 `"<think>用户发送了一条试图绕过系统指令的消息..."` — refuse 检测无法识别 think 内的拒绝表态。

Task 4.1.A 拆 THINKING 后 text 干净了,`inj-01` 直接 pass。**hardFailRate 40% → 25% → 0%**(完整 4 case 回归全过)。

---

## Task 4.2:Plan-and-Execute 模式对比

### 4.2.A 基础设施

**`src/agent/langgraph-agent.ts`** 1 行:`function buildChatModel` → `export function buildChatModel`。planner 复用同一份 LLM 实例化(baseURL/key/temperature 全部一致,才能跟 ReAct 公平对比)。

**`src/agent/ag-ui.ts`** 加 `PLAN_GENERATED` 事件:
```ts
export type PlanStep = { id: string; goal: string; tool: string; args: Record<string, unknown> }
export type PlanGeneratedEvent = BaseEvent & {
  type: EventType.PLAN_GENERATED
  plan: { rationale: string; steps: PlanStep[] }
}
export function createPlanGenerated(plan): PlanGeneratedEvent { ... }
```

事件自动持久化到 `agent_run_events`(runManager pump 不挑事件类型),续订时回放。前端不消费(switch fall through),后续 web 迭代可加 UI。

### 4.2.B 核心:`src/agent/planner.ts:runPlannerAgent`(490 行)

**签名与 `runLangGraphAgent` 完全一致**,runManager dispatch 0 侵入:
```ts
export async function* runPlannerAgent(
  pool, config, messages, threadId, runId, _resume?,
  options?: { signal?, onUsage?, log? }
): AsyncGenerator<AgUiEvent>
```

**三阶段流程**:

```
PLAN  → EXECUTE → SYNTHESIZE
LLM 1   N tool   LLM 2
runs
```

**阶段 1 - Plan**:

```ts
// plan zod schema
const PlanStepSchema = z.object({
  id: z.string(),
  goal: z.string(),
  tool: z.enum(['search_destinations', 'get_destination_detail', 'web_search']),
  args: z.record(z.string(), z.unknown())
})
const PlanSchema = z.object({
  rationale: z.string(),
  steps: z.array(PlanStepSchema).min(1).max(10)
})

// plan 阶段 system prompt(硬编码,不走 PromptTemplate 体系 — 这是 planner 协议)
function buildPlanSystemPrompt() {
  return [
    '你是任务规划助手...',
    '**严格规则**:',
    '1. 只输出 JSON,不要 markdown 代码块',
    '2. 每步必须指定 tool + args(完整值)',
    '3. **不支持引用前一步结果**',
    ...,
    `工具清单:${JSON.stringify(getToolDefinitions().map(...))}`
  ].join('\n')
}

// 失败重试 1 次,再败 RUN_ERROR(不静默 fallback 到 ReAct)
async function tryPlan(model, userPrompt, baseSystemPrompt, options, onChunkEnd) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { events, fullText } = await collectStreamedText(...)
    const jsonStr = stripMarkdownFence(fullText.trim())
    try {
      const parsed = JSON.parse(jsonStr)
      const validated = PlanSchema.safeParse(parsed)
      if (validated.success) return { ok: true, plan: validated.data, ... }
    } catch { ... }
    // retry 时给 LLM 明确反馈
    messages.push(new HumanMessage(`上次输出无法解析(${lastError})。请严格按 JSON Schema 重新输出...`))
  }
  return { ok: false, error: lastError, events: allEvents }
}
```

**阶段 2 - Execute**:

```ts
for (const step of planResult.plan.steps) {
  yield createStepStarted('tool_call')
  yield createToolCallStart(toolCallId, step.tool)
  if (argsJson !== '{}') yield createToolCallArgs(toolCallId, argsJson)
  yield createToolCallEnd(toolCallId)
  yield createStepFinished('tool_call')

  const result = await runTool(pool, config, step.tool, JSON.stringify(step.args))
  // tool 失败不中断 — error 字符串塞进 result 让 synth 处理
  if (result.sources) sourceMap.set(...)

  yield createStepStarted('tool_execution')
  yield createToolCallResult(toolCallId, result.text)
  yield createStepFinished('tool_execution')

  // 复用 4.1.B 的 tool finished 日志格式(带 mode='plan' 区分)
  options?.log?.info({ tool, toolCallId, durationMs, ..., mode: 'plan' }, 'tool finished')
}
```

**阶段 3 - Synthesize**:

```ts
yield createStepStarted('synthesis')
const synthMessages = [
  new SystemMessage(systemPrompt + SYNTH_PROMPT_SUFFIX),
  new HumanMessage([
    `用户问题:${userPrompt}`,
    `计划理由:${plan.rationale}`,
    '步骤与结果:',
    ...stepOutcomes.map((o, i) => `[${i+1}] ${o.step.goal} (tool=${o.step.tool}, ok=${o.ok})\n    result: ${...}`)
  ].join('\n'))
]
yield* streamLLMText(model, synthMessages, options, onChunkEnd)
yield createStepFinished('synthesis')
```

**复用 thinkSplit 状态机**:plan / synth 阶段都可能出 `<think>`,共用 4.1.A 的切分逻辑(两个本地 helper `collectStreamedText` / `streamLLMText`)。

**已知限制**(写入文件头注释):
- 不支持步骤间参数引用(`{{prev.id}}`),plan 时必须给出字面值
- 不支持失败 fallback 到 ReAct(失败暴露,让 LLM 在 synth 里处理 error)
- plan 阶段也走 streaming 是为了 abort + thinkSplit 复用,代价是 2 次 LLM round trip

### 4.2.C handler + runManager mode 切换(diff)

**`src/index.ts`**:
```diff
   Body: { message?: string; promptVersion?: string; mode?: 'react' | 'plan' }
   ...
   const mode: 'react' | 'plan' = req.body?.mode === 'plan' ? 'plan' : 'react'
   ...
-  const runId = await runManager.start(sessionId, msgs, reqLog)
+  const runId = await runManager.start(sessionId, msgs, reqLog, mode)
-  reqLog.info({ runId }, 'run started')
+  reqLog.info({ runId, mode }, 'run started')
```

**`src/agent/runManager.ts`**:
```diff
+ export type RunMode = 'react' | 'plan'
+ type RunHandle = { ..., mode: RunMode }

   async start(sessionId, messages, parentLog?, mode: RunMode = 'react'): Promise<string> {
-    const log = (parentLog ?? this.log).child({ runId })
+    const log = (parentLog ?? this.log).child({ runId, mode })

-    const generator = runLangGraphAgent(...)
+    const generator = mode === 'plan'
+      ? runPlannerAgent(this.pool, this.config, messages, sessionId, runId, undefined, agentOptions)
+      : runLangGraphAgent(this.pool, this.config, messages, sessionId, runId, undefined, agentOptions)
   }

   // finalize 的 run summary 加 mode 字段(child binding 已绑,这里冗余写让单行 grep 直观)
   handle.log.info({ status, mode: handle.mode, durationMs, ... }, 'run summary')
```

### 4.2.D 评测扩展 + 对比实验脚本

**`src/eval/runner.ts:runForEval`** 加 optional `mode: EvalMode = 'react'`:
```ts
export type EvalMode = 'react' | 'plan'
export async function runForEval(pool, config, caseItem, promptVersion, mode = 'react') {
  ...
  const runFn = mode === 'plan' ? runPlannerAgent : runLangGraphAgent
  for await (const event of runFn(...)) { ... }
}
```

**`scripts/eval-plan-vs-react.ts`**(NEW,200+ 行):跑 7 个 case × 2 模式 = 14 次评测,输出:
- 控制台:每 case react / plan 横向 diff(steps、duration、tokens),底部 mode 聚合
- JSON 报告:`docs/02-实验记录/exp-05-plan-vs-react-{ISO}.json`

`package.json` 加 script:
```json
"eval:plan-vs-react": "tsx scripts/eval-plan-vs-react.ts"
```

### 4.2 实测对比表(`exp-05-plan-vs-react-2026-06-02T02-33-25-465Z.json`)

| caseId | react steps | plan steps | react dur | plan dur | Δdur | react tokens | plan tokens | Δtokens | 胜方 |
|--------|-------------|------------|-----------|----------|------|--------------|-------------|---------|------|
| `kw-01`(单关键词) | 1 | 1 | 5.0s | 11.2s | **+6.1s** | 3714 | 3108 | -606 | react(overhead) |
| `detail-01`(列举丽江美食) | 3 | 2 | 14.2s | **4.8s** | **-9.5s** | 7480 | **2839** | -4641 | **plan 大胜** |
| `web-01`(北京景点) | 1 | 1 | 3.3s | 5.9s | +2.7s | 3460 | 4696 | +1236 | react(overhead) |
| `free-02`(云南三日游) | 3 | 1 | 21.8s | **10.2s** | **-11.5s** | 9568 | **5438** | -4130 | **plan 大胜** |
| `ask-01`(信息不足反问) | 0 | 1 | 4.9s | 20.2s | **+15.3s** | 1746 | 5044 | +3298 | **react 大胜**(plan 不擅反问) |
| `inj-01`(注入攻击) | 0 | 1 | 2.1s | 8.5s | +6.4s | 1689 | 4865 | +3176 | react(plan 强行规划) |
| `plan-7day-yunnan`(7 天云南游) | 4 | 2 | 14.7s | **7.0s** | **-7.7s** | 8436 | **3113** | -5323 | **plan 大胜** |

**模式聚合**(7 case 平均):

| 指标 | react | plan | diff |
|------|-------|------|------|
| ok 率 | 7/7 | 7/7 | 持平 |
| 平均 steps | 1.7 | 1.3 | plan ↓24% |
| 平均 duration | 9.4s | 9.7s | 持平(plan 略慢) |
| 平均 tokens | 5156 | 4158 | **plan ↓19%** |

**结论**(可直接当面试 STAR 故事):

| 维度 | ReAct 优 | Plan 优 |
|------|---------|---------|
| 简单 1 步任务 | ✅(plan 多 1 次 LLM overhead) | ❌ |
| 复杂多步任务 | ❌(需多轮试错) | ✅(预先规划省试错 token) |
| 反问 / 模糊需求 | ✅(可立刻 [ASK_USER]) | ❌(强行规划无意义工具) |
| 注入攻击 | ✅(立刻拒绝) | ❌(强行规划,然后才拒绝) |
| 整体 token 成本 | 5156 avg | **4158 avg**(plan 省 19%) |

**为什么 plan 在复杂任务省 token**:ReAct 每轮要把"全部 history + 工具结果"重新喂给 LLM,N 轮就 N 倍 prompt token;P&E plan 阶段只看用户问题(短),synth 阶段看一次结果汇总(中等),省的是 prompt 的 N 次重复。

**为什么 plan 跟反问场景冲突**:plan 阶段强制要求模型输出"steps >= 1",但反问的本质是"我啥都没干、需要更多信息",跟 plan 的"规划行动序列"语义矛盾。**这是设计层面的局限**,跟 Anthropic 在 P&E 文档里讲的"reactive vs deliberative"对应。

---

## 附录:全部代码改动速查

| 改动类型 | 路径 | Task | 改动一句话 |
|---------|------|------|------|
| **新增** | `src/agent/thinkSplit.ts` | 4.1.A | 跨 chunk `<think>` 状态机(151 行,11 边界单测全过) |
| | `src/agent/planner.ts` | 4.2.B | Plan-and-Execute Agent 三阶段实现(490 行) |
| | `scripts/eval-plan-vs-react.ts` | 4.2.D | 7 case × 2 mode 对比实验脚本(200+ 行) |
| **改代码** | `src/agent/ag-ui.ts` | 4.1.A + 4.2.A | 加 `THINKING_*` × 3 + `PLAN_GENERATED` × 1 事件类型 + 构造器 |
| | `src/agent/langgraphToAgUi.ts` | 4.1.A + 4.1.B | reasoning_content 双通道、thinkSplit 接入、`Ctx.log`、on_tool_end timing 日志 |
| | `src/agent/langgraph-agent.ts` | 4.1.B + 4.2.A | `options.log` 透传、`export buildChatModel` |
| | `src/agent/runManager.ts` | 4.1.B + 4.1.C + 4.2.C | child logger 绑 runId + mode、`computeCostUsd`、`'run summary'`、mode dispatch |
| | `src/agent/token-usage.ts` | 4.1.C | 新增 `computeCostUsd(usage, config)` helper |
| | `src/index.ts` | 4.1.B + 4.2.C | `runManager.start(sid, msgs, reqLog, mode)`、Body 加 mode |
| | `src/eval/runner.ts` | 4.2.D | `runForEval` 加 optional `mode` 参数 + dispatch |
| | `web/src/App.tsx` | 4.1.D | `ChatMsg.thinking`、`THINKING_CONTENT` case、`<details>` 折叠区 |
| | `package.json` | 4.2.D | 加 `eval:plan-vs-react` script |
| **不改 schema** | `agent_run_events` 表 | 4.1 + 4.2 | 新事件 JSON 直接落 `event_json`,无 migration |
| **不改 header** | `X-Trace-Id` | 4.1.B | 整合-2 已设 = runId,语义满足 Task 4.1 要求 |
| **改前端** | `web/src/api.ts` | 4.2 | 加 `AgentMode` / `PlanStep` / `PlanData` 类型;`sendMessageStream` 加 `mode?` 参数透传 |
| | `web/src/App.tsx` | 4.2 | `ChatMsg.plan` 字段、`mode` state、`PLAN_GENERATED` case 消费、handleSend/Option 传 mode、计划清单 `<details open>` UI(显示 rationale + N 步 + 工具名)、输入区上方 react/plan 单选切换 |
| **文档同步** | `docs/04-架构文档/agent-架构.md` | 4.1 + 4.2 | §1.2 模块表 / §4.2 事件时序 / §6 局限表 |
| **实验产出** | `docs/02-实验记录/exp-05-plan-vs-react-2026-06-02T02-33-25-465Z.json` | 4.2 | 7 case × 2 mode 完整数据 |

---

## 验证命令

```bash
# 0. 切 Node 22(LangChain 1.x 要 >=20)
nvm use 22

# 1. 类型检查
npx tsc --noEmit

# 2. ReAct 回归(确保 4.2 没破现有)
npm run eval -- --version v1_base --case ask-01,detail-01,inj-01,web-01 --sleep 1000
# 期望:pass=4/4 hardFailRate=0.0%

# 3. Plan vs ReAct 完整对比
npm run eval:plan-vs-react
# 期望:7 case × 2 mode 全 ok;exp-05-*.json 产出

# 4. mode=plan 烟雾(实际项目里前端配 mode 选择器后,curl 模拟前端调用)
curl -X POST http://localhost:3001/sessions/<SID>/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"丽江有什么代表性的美食","mode":"plan"}' \
  --max-time 60

# 5. trace 日志验证(grep 一个 runId 拿完整链路)
grep '<RUN_ID>' logs/app.log | jq -c '{level, msg, runId, mode, tool, durationMs, totalTokens}'
# 期望看到:run started → plan generated → tool finished × N → run summary
```

---

## Task 4.3：记忆分层（长期记忆 + 用户画像）

### 关联八股

- `05-记忆系统.md §长期记忆`（**首次实践**：语义摘要 = semantic memory 的工程形态）
- `05-记忆系统.md §短期记忆`（与整合-2 的 `agent_run_events` 事件流水对照：episodic vs semantic）

### 4.3.A 新增 `src/db/migrations/005_session_summary.sql`

```sql
ALTER TABLE chat_sessions ADD COLUMN summary TEXT NULL AFTER status;
```

### 4.3.B 新增 `src/agent/memory.ts`（~100 行）

三个核心函数：

| 函数 | 位置 | 用途 |
|------|------|------|
| `shouldSummarize(messageCount, threshold, existingSummary)` | `memory.ts:40` | 纯函数判断是否触发摘要 |
| `generateSummary(config, messages, existingSummary)` | `memory.ts:50` | 调 `buildChatModel` 生成/增量更新摘要 |
| `maybeUpdateMemory(pool, config, sessionId, messages, log)` | `memory.ts:68` | fire-and-forget 入口 |

**摘要 prompt 提取维度**：出发城市、旅行风格偏好、预算、时间偏好、同行人群、目的地态度、特殊需求。不超过 300 字。增量更新（有旧摘要时在其基础上更新）。

### 4.3.C Prompt 模板扩展

- `prompts/types.ts`：新增 `memoryContext?: string` + `skillsContext?: string` 字段
- `prompts/render.ts`：在 taskScope 之后渲染 memoryContext/skillsContext（interpolate 后 trim 为空则跳过）
- `prompts/v1_base.ts`：`memoryContext: '用户画像(基于历史对话摘要):\n{{memory_summary}}'`，`variables: ['memory_summary', 'skills_context']`

### 4.3.D 钩入 RunManager

- `RunHandle` 新增 `messages: ChatMessage[]`（`runManager.ts:80`）
- `start()` 时存 messages（`runManager.ts:138`）
- `finalize()` 中 status=completed/interrupted 时 fire-and-forget 调 `maybeUpdateMemory`（`runManager.ts:420`）

### 4.3.E 注入到 Index

- `POST /sessions/:id/stream` 中 `getPrompt` 前查 `getSessionSummary`
- 传 `{ memory_summary, skills_context }` 给 `getPrompt`

### 记忆形态对照

| 维度 | 事件流水（整合-2） | 语义摘要（Task 4.3） |
|------|---------------------|---------------------|
| 对应八股 | 短期记忆 / episodic memory | 长期记忆 / semantic memory |
| 存储 | `agent_run_events(run_id, seq, event_json)` | `chat_sessions.summary` |
| 粒度 | 事件级（每个 AG-UI 事件一行） | 会话级（一段 300 字摘要） |
| 更新频率 | 每个事件实时写入 | Run 完成后按阈值触发 |
| 用途 | 续订回放、审计 | 跨对话偏好记忆、prompt 注入 |

---

## Task 4.4：MCP 接入 + Agent Skills + 动态 RAG

### 关联八股

- `04-工具调用.md §6` MCP 协议（**首次实践**：用 `@langchain/mcp-adapters` 接入 3 个外部 MCP Server）
- `04-工具调用.md §7` Agent Skills（工具 → 工具集 → 技能三层抽象）
- `02-核心框架.md §Tool ecosystems`

### 4.4.A 删除本地 SQL 工具全链路

**删除文件**：
- `src/agent/tools.ts`（`runTool`、`getToolDefinitions`、`search_destinations`、`get_destination_detail`）
- `src/db/destinationRepo.ts`
- `scripts/seed.ts`

**修改 `ag-ui.ts`**：`Source` 从 `DestinationSource`（destination 专用）改为通用 `{ type, name, metadata }`

**修改 `package.json`**：`setup` script 去掉 `tsx scripts/seed.ts`

### 4.4.B 新增 `src/mcp/client.ts` — McpManager（~90 行）

```ts
export class McpManager {
  private client: MultiServerMCPClient | null = null
  private tools: StructuredToolInterface[] = []
  constructor(private config: AppConfig) {}
  async init(): Promise<void>       // 按 config 启动 MCP servers
  getTools(): StructuredToolInterface[]
  getToolNames(): string[]
  async shutdown(): Promise<void>
}
```

**MCP Server 配置**：
| Server | 条件 | 用途 |
|--------|------|------|
| `@anthropic/mcp-server-fetch` | 始终启动 | 通用网页抓取 |
| `@modelcontextprotocol/server-filesystem` | `MCP_FILESYSTEM_ALLOWED_DIRS` 非空 | 本地文件访问 |
| `@amap/amap-maps-mcp-server` | `MCP_AMAP_API_KEY` 非空 | 高德地图 POI/天气 |

关键设计：`onConnectionError: 'ignore'` — 单个 server 挂不影响其他；`throwOnLoadError: false` — 工具加载失败降级。

### 4.4.C Agent 入口改造（最核心改动）

**`langgraph-agent.ts`**：
- 删除 `buildTools()`、`sourceKey()`、`runTool` import
- `runLangGraphAgent` 签名改为 `(config, tools: StructuredToolInterface[], messages, ...)` — 去掉 `pool`
- `createAgent({ model, tools, ... })` 直接用传入的 MCP tools

**`planner.ts`**：
- 签名同样改为接收 `tools: StructuredToolInterface[]`
- `PlanStepSchema.tool` 从 `z.enum([...])` 改为 `z.string().refine(name => toolNames.includes(name))`
- `buildPlanSystemPrompt(tools)` 从 MCP 工具动态序列化 name/description/schema
- 工具执行从 `runTool(pool, config, ...)` 改为 `tools.find(t => t.name === step.tool).invoke(step.args)`

**`runManager.ts`**：constructor 新增 `mcpManager: McpManager`；`start()` 中 `this.mcpManager.getTools()` 传给 agent

**`index.ts`**：
- `main()` 中 `McpManager.init()` → 日志打印工具列表 → `new RunManager(..., mcpManager)`
- `shutdown()` 中 `mcpManager.shutdown()`

### 4.4.D Skills 框架

**新增目录结构**：
```
src/skills/
  types.ts              — Skill 类型定义
  loader.ts             — 注册表 + buildSkillsPromptSection
  travel-recommend/
    skill.ts            — 旅行目的地推荐 Skill
  local-research/
    skill.ts            — 信息调研 Skill
```

**Skill 类型**：`{ name, description, systemPromptExtension, requiredTools, triggerKeywords? }`

**Prompt 集成**：`buildSkillsPromptSection(skills, availableToolNames)` 根据实际可用工具过滤，生成注入 system prompt 的段落。

### 4.4.E Prompt + Eval 更新

- `v1_base.ts` toolUsageRules 从 SQL 工具引用改为 MCP 通用描述
- `v2_cot.ts` cotInstruction 删除具体工具名
- `eval/testset.ts` 删除 `keyword_search`/`detail_list` category 和 kw-*/detail-* case
- `eval/runner.ts` 签名从 `(pool, config, ...)` 改为 `(config, tools, ...)`

### 关键决策

| 决策 | 理由 |
|------|------|
| ✅ 删除所有本地 SQL 工具 | 用户明确要求；MCP 提供更灵活的工具发现 |
| ✅ MCP Client 用 `@langchain/mcp-adapters` | 无缝转换为 LangChain StructuredTool，0 改造 createAgent |
| ✅ Planner 动态发现工具 | `z.string().refine()` 替代硬编码 `z.enum()`，适配运行时 MCP 工具 |
| ✅ fetch server 始终启动 | 通用性强，无需 API key，保证最低工具可用性 |
| ✅ Skills 只做 prompt 注入 | 不做运行时 Skill 路由选择（模型根据 description 自行决策），KISS |
| ❌ 未升级 Checkpointer | 继续 MemorySaver，与 Task 4.3 独立 |

---

## 附录：Task 4.3 + 4.4 代码改动速查

| 改动类型 | 路径 | Task | 改动一句话 |
|---------|------|------|------|
| **新增** | `src/db/migrations/005_session_summary.sql` | 4.3 | chat_sessions 加 summary 字段 |
| | `src/agent/memory.ts` | 4.3 | 对话摘要生成 + fire-and-forget 入口 |
| | `src/mcp/client.ts` | 4.4 | McpManager：MCP Server 生命周期管理 |
| | `src/skills/types.ts` | 4.4 | Skill 类型定义 |
| | `src/skills/loader.ts` | 4.4 | Skill 注册表 + prompt 段落构建 |
| | `src/skills/travel-recommend/skill.ts` | 4.4 | 旅行推荐 Skill |
| | `src/skills/local-research/skill.ts` | 4.4 | 信息调研 Skill |
| **删除** | `src/agent/tools.ts` | 4.4 | 本地 SQL 工具全部删除 |
| | `src/db/destinationRepo.ts` | 4.4 | destination 表 CRUD 删除 |
| | `scripts/seed.ts` | 4.4 | 种子数据脚本删除 |
| **改代码** | `src/config.ts` | 4.3+4.4 | 加 MCP_ENABLED / MCP_AMAP_API_KEY / MEMORY_SUMMARY_THRESHOLD |
| | `src/db/chatRepo.ts` | 4.3 | 加 updateSessionSummary / getSessionSummary |
| | `src/agent/prompts/types.ts` | 4.3+4.4 | 加 memoryContext / skillsContext 字段 |
| | `src/agent/prompts/render.ts` | 4.3+4.4 | 加 memoryContext / skillsContext 渲染 |
| | `src/agent/prompts/v1_base.ts` | 4.3+4.4 | memoryContext + skillsContext + toolUsageRules 全部重写 |
| | `src/agent/prompts/v2_cot.ts` | 4.4 | cotInstruction 删除具体工具名 |
| | `src/agent/ag-ui.ts` | 4.4 | Source 从 DestinationSource 改为通用类型 |
| | `src/agent/langgraph-agent.ts` | 4.4 | 删 buildTools，接收 tools 参数 |
| | `src/agent/planner.ts` | 4.4 | 动态工具发现 + invoke 替代 runTool |
| | `src/agent/runManager.ts` | 4.3+4.4 | 加 McpManager + messages + memory 钩子 |
| | `src/index.ts` | 4.3+4.4 | MCP 生命周期 + Skills + 记忆注入 |
| | `src/eval/testset.ts` | 4.4 | 删 SQL 工具相关 case/category |
| | `src/eval/runner.ts` | 4.4 | 签名改为 (config, tools) |
| **依赖** | `package.json` | 4.4 | 加 `@langchain/mcp-adapters`；setup 去掉 seed.ts |
