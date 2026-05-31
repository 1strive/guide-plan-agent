# 阶段1 开发笔记:LLM 基础三件套(代码改动速查)

> **本文目标**:把 `docs/开发规划.md` 阶段1 Task 1.1 / 1.2 落地的**每一处代码改动**记录清楚,方便下次接手 / 回看 / 排错时直接跳到对应文件,不用逆向猜实现。
>
> 不讲 Transformer/Tokenizer 原理(原理见 `docs/01-面试八股文/07-大模型基础.md`、`09-Prompt工程.md §2.4`),只列"做了什么、改了哪、为什么"。
>
> **配套文档**:架构总图 `docs/04-架构文档/agent-架构.md §3.1 / §3.2 / §5.1`;温度对照实验 `docs/02-实验记录/exp-01-temperature.md`。

---

## 总览

| Task | 一句话 | 新增文件 | 改动文件 |
|------|--------|----------|---------|
| 1.1 | 把 `/sessions/:id/chat` 改成 SSE 流式 + 推理参数透传 | — | `src/agent/llm.ts` `src/index.ts` `src/config.ts` `.env` |
| 1.2 | 流式 usage 透传 + fallback 估算 + 成本日志 + 会话级累加 | `src/agent/token-usage.ts` | `src/agent/llm.ts` `src/index.ts` `src/config.ts` `src/db/chatRepo.ts` `.env` |

三件套(Transformer / Token / 推理参数)在代码里的落点:
- **Transformer**:对调方透明,只通过 `OPENAI_MODEL` 选模型
- **Token**:`stream_options.include_usage` 拿真值 + `estimateTokens` 兜底
- **推理参数**:`LLM_TEMPERATURE / LLM_TOP_P / LLM_MAX_TOKENS` 全量透传到 chat/completions body

---

## Task 1.1:流式输出 + 推理参数透传

### 改 `src/agent/llm.ts`

**1. 新增 `postChatStream` — 解析 OpenAI SSE 协议为 chunk 生成器**(`llm.ts:85`):

```ts
async function* postChatStream(
  config, body, signal
): AsyncGenerator<StreamChunk> {
  // 超时兜底:外层 abort 之外加一道 LLM_REQUEST_TIMEOUT_MS 总超时
  const timeoutCtl = new AbortController()
  const timer = setTimeout(() => timeoutCtl.abort(), config.LLM_REQUEST_TIMEOUT_MS)
  const linkedSignal = signal ? anySignal([signal, timeoutCtl.signal]) : timeoutCtl.signal

  const res = await fetch(chatUrl(config), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}`, ... },
    body: JSON.stringify({
      ...body,
      stream: true,
      stream_options: { include_usage: true }   // Task 1.2:让最后一个 chunk 带 usage
    }),
    signal: linkedSignal
  })

  // 解析 SSE:按行切,跳过心跳行(":")和 [DONE],data: 之后 JSON.parse 出 chunk
  // try/catch 单条坏 chunk → 跳过不中断流(八股 08 §3.2 降级而非中断)
  for await (...) yield chunk
}
```

**2. `runAgentStream` 内部把推理参数全量透传**(`llm.ts:248`):

```ts
const stream = postChatStream(config, {
  model: config.OPENAI_MODEL,
  messages: current,
  tools,
  tool_choice: 'auto',
  // Task 1.1 / 八股 09 §2.4:推理参数全量透传
  temperature: config.LLM_TEMPERATURE,    // 默认 0.4
  top_p: config.LLM_TOP_P,                // 默认 1
  max_tokens: config.LLM_MAX_TOKENS       // 默认 2048
}, signal)
```

**3. `anySignal` 多 AbortSignal 合并工具**(`llm.ts:156`):任一触发即整体 abort,把"客户端断开"和"请求超时"两个 signal 串成一个传给 fetch。

### 改 `src/index.ts`

`POST /sessions/:id/stream` 接管 raw socket 自己写 SSE(`index.ts:114`):

```ts
reply.hijack()
reply.raw.writeHead(200, {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'X-Trace-Id': runId
})

// 客户端断开 → abort
const ctl = new AbortController()
req.raw.once('close', () => { if (!ctl.signal.aborted) ctl.abort() })

// 15s 心跳防代理 idle 断连
const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)

for await (const event of runAgentStream(..., { signal: ctl.signal, onUsage })) {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
}
```

**为什么 hijack**:Fastify 默认会等 handler 返回再 flush,流式必须自己管 socket 生命周期。

### 改 `src/config.ts`

加 zod 字段(`config.ts:32`):

```ts
LLM_TEMPERATURE: z.coerce.number().default(0.4),
LLM_MAX_TOKENS: z.coerce.number().default(2048),
LLM_TOP_P: z.coerce.number().default(1),
LLM_REQUEST_TIMEOUT_MS: z.coerce.number().default(60_000)
```

**为什么 T 选 0.4**:旅游推荐既要稳定(JSON 工具调用解析)又要有一点多样性,0.4 是平衡点(对照实验见 `exp-01`)。

### 改 `.env`

```env
LLM_TEMPERATURE=0.4
LLM_TOP_P=1
LLM_MAX_TOKENS=2048
LLM_REQUEST_TIMEOUT_MS=60000
```

---

## Task 1.2:Token 计数 + 成本控制

### 新增 `src/agent/token-usage.ts`

3 件套:类型 + fallback 估算 + 累加器(全文 22 行):

```ts
export type TokenUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

// 兜底估算:length / 2 是中英混合下的保守上界
// 中文 1 字 ≈ 1~1.5 token,英文 4 字 ≈ 1 token,取 0.5 token/字偏保守
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

// 多轮 ReAct 的 usage 累加
export function accumulateUsage(base, next): TokenUsage {
  return {
    promptTokens: (base?.promptTokens ?? 0) + next.promptTokens,
    completionTokens: (base?.completionTokens ?? 0) + next.completionTokens,
    totalTokens: (base?.totalTokens ?? 0) + next.totalTokens
  }
}
```

**为什么不用 tiktoken**:① +30KB 依赖;② 不同模型 tokenizer 不通用(GPT/Claude 各一套);③ MiniMax tokenizer 不开源;④ ±20% 误差在成本审计场景可接受。阶段5 网关层做精细计费时再升级。

### 改 `src/agent/llm.ts`

**1. `postChatStream` 请求体声明 `stream_options.include_usage: true`**(`llm.ts:109`):流式默认不返回 usage,必须主动声明。

**2. `StreamChunk` 类型加 usage 字段**(`llm.ts:64`):

```ts
type StreamChunk = {
  choices?: [...]
  // Task 1.2:仅最后一个 chunk 带(choices 通常为空)
  // 协议层 snake_case,业务层会转 camelCase
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}
```

**3. `runAgentStream` 每轮收 usage + fallback 兜底**(`llm.ts:277`):

```ts
let lastUsage: TokenUsage | null = null

for await (const chunk of stream) {
  if (chunk.usage) {
    // snake_case → camelCase 边界转换
    lastUsage = {
      promptTokens: chunk.usage.prompt_tokens,
      completionTokens: chunk.usage.completion_tokens,
      totalTokens: chunk.usage.total_tokens
    }
  }
  ...
}

// API 不返回 usage 时(部分 MiniMax 兼容协议不实现)→ 用字符数估算
const roundUsage: TokenUsage = lastUsage ?? (() => {
  const promptText = current.map(m => m.content ?? '').join('\n')
  return {
    promptTokens: estimateTokens(promptText),
    completionTokens: estimateTokens(assistantContent),
    totalTokens: ...
  }
})()
totalUsage = accumulateUsage(totalUsage, roundUsage)
options?.onUsage?.(roundUsage, round)
```

### 改 `src/index.ts`

**1. handler 拿 `onUsage` 回调累加 + 打日志**(`index.ts:211`):

```ts
const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
const onUsage = (u: TokenUsage, round: number) => {
  totalUsage.promptTokens += u.promptTokens
  totalUsage.completionTokens += u.completionTokens
  totalUsage.totalTokens += u.totalTokens
  reqLog.info({ round, usage: u, model: config.OPENAI_MODEL }, 'llm round usage')
}

// 跑完后算成本 + 写聚合日志
const costInput  = (totalUsage.promptTokens / 1000) * config.MODEL_PRICE_INPUT_PER_1K
const costOutput = (totalUsage.completionTokens / 1000) * config.MODEL_PRICE_OUTPUT_PER_1K
reqLog.info({
  model: config.OPENAI_MODEL,
  usage: totalUsage,
  cost_usd: Number((costInput + costOutput).toFixed(6)),
  duration_ms: Date.now() - startedAt
}, 'agent run summary')
```

**2. 累计 token 写回 chat_sessions**(`index.ts:275`):

```ts
if (totalUsage.totalTokens > 0) {
  await updateSessionTokens(pool, sessionId, totalUsage.totalTokens)
}
```

### 改 `src/db/chatRepo.ts`

新增 `updateSessionTokens(pool, sessionId, deltaTokens)` — 把本次累计 token 累加到 `chat_sessions.total_tokens`,便于按会话维度做成本审计。

### 改 `src/config.ts`

加计价字段(`config.ts:36`):

```ts
MODEL_PRICE_INPUT_PER_1K:  z.coerce.number().default(0),
MODEL_PRICE_OUTPUT_PER_1K: z.coerce.number().default(0)
```

**为什么输入输出分开**:输出通常贵 3~5 倍(GPT-4o-mini 是 4 倍),分开才能算准。

### 改 `.env`

```env
MODEL_PRICE_INPUT_PER_1K=0.00015
MODEL_PRICE_OUTPUT_PER_1K=0.0006
```

---

## 完整调用链路(以一次普通对话为例)

```
1. POST /sessions/:id/stream { message }
       │
       ▼
2. src/index.ts handler:
   insertMessage(user)
   listRecentMessages → history
   getPrompt(version) → { system, prependMessages }
   拼 msgs:[system] + prependMessages + history
       │
       ▼
3. reply.hijack() + writeHead(SSE headers)
   AbortController + req.raw 'close' 监听
   setInterval 15s 心跳
       │
       ▼
4. runAgentStream(pool, config, msgs, ..., { signal, onUsage }):
   for round in 0..LLM_MAX_TOOL_ROUNDS:
     postChatStream({
       model, messages, tools,
       temperature, top_p, max_tokens,    ← Task 1.1
       stream_options: { include_usage: true }  ← Task 1.2
     })
       │
       ▼
5. 解析 SSE chunks:
   - delta.content     → yield TextMessageContent(每个 token)
   - delta.tool_calls  → yield ToolCallStart/Args/End
   - chunk.usage       → lastUsage = camelCase                 ← Task 1.2
       │
       ▼
6. 一轮结束:
   roundUsage = lastUsage ?? estimateTokens 兜底              ← Task 1.2
   totalUsage = accumulate(totalUsage, roundUsage)
   onUsage(roundUsage, round) → 写 round 日志
       │
       ▼
7. (有 tool_calls → 执行 → continue;无 → break)
       │
       ▼
8. yield RUN_FINISHED { outcome, totalUsage }
       │
       ▼
9. handler:
   reply.raw.write 每个 event 推送给前端
   updateSessionTokens(sessionId, totalUsage.totalTokens)     ← Task 1.2
   写聚合日志 { usage, cost_usd, duration_ms }                ← Task 1.2
   reply.raw.end()
```

---

## 附录:全部代码改动速查

| 改动类型 | 路径 |
|---------|------|
| **新增** | `src/agent/token-usage.ts`(TokenUsage 类型 + estimateTokens + accumulateUsage) |
| **改动** | `src/agent/llm.ts`(postChatStream / runAgentStream / 推理参数透传 / usage 收集) |
| | `src/index.ts`(`/sessions/:id/stream` 路由 / reply.hijack / onUsage / cost 日志 / updateSessionTokens) |
| | `src/config.ts`(LLM_TEMPERATURE / LLM_TOP_P / LLM_MAX_TOKENS / LLM_REQUEST_TIMEOUT_MS / MODEL_PRICE_*) |
| | `src/db/chatRepo.ts`(新增 updateSessionTokens) |
| | `.env` / `.env.example`(全部新增配置项) |
| **产出** | `docs/02-实验记录/exp-01-temperature.md`(0.2 / 0.4 / 0.7 三档对照) |

---

## 验证命令

```bash
# 1. 起服务
npm run dev

# 2. 建会话 + 跑流式对话
SESSION=$(curl -s -XPOST localhost:3000/sessions | jq -r .sessionId)
curl -N -XPOST localhost:3000/sessions/$SESSION/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"哈尔滨冬天有什么好玩的"}'

# 3. 看日志里的 usage / cost_usd
tail -f logs/app.log | jq 'select(.msg=="agent run summary")'

# 4. 看会话累计 token
curl -s localhost:3000/sessions | jq '.sessions[] | {id, total_tokens}'

# 5. 温度对照(改 .env LLM_TEMPERATURE 后重启,对比 free-01/02/03 输出)
npm run eval -- --case free-01,free-02,free-03 --version v1_base
```
