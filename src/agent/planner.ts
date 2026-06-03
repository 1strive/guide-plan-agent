/**
 * Task 4.2 — Plan-and-Execute Agent(对照 ReAct 的另一种 Agent 范式)
 *
 * 规划:docs/开发规划.md Task 4.2
 * 八股:02-核心框架.md §3 Plan-and-Execute / §Q "ReAct vs Plan-and-Execute 怎么选"
 *
 * 三阶段流程:
 *   ┌─────────────┐    ┌──────────────────────┐    ┌──────────────┐
 *   │ PLAN(LLM1)│───>│ EXECUTE(顺序 runTool)│───>│ SYNTHESIZE   │
 *   │             │    │                       │    │   (LLM2)     │
 *   └─────────────┘    └──────────────────────┘    └──────────────┘
 *
 * 跟 ReAct 的关键差异:
 * - ReAct:LLM 一边想一边调工具,**思考与行动交错**(多轮 round trip)
 * - P&E:LLM 先把整个步骤列表想完(单次 JSON 输出),按列表跑工具,最后整合
 *
 * 设计要点:
 * - **签名与 runLangGraphAgent 完全一致** → runManager.start 用 mode 一行 if/else 切换,0 侵入
 * - **复用现有事件协议** → 只多加 PLAN_GENERATED;前端 STEP_STARTED('planning'/'tool_call'/'tool_execution'/'synthesis')
 *   分桶不需要前端改动(switch 默认 fall through)
 * - **复用 thinkSplit** → plan 阶段和 synth 阶段都可能出 <think>...</think>,统一处理
 * - **abort signal 三段贯穿** → plan LLM call、每次 runTool、synth LLM call 都接 signal
 *
 * 已知限制(刻意保留作为 ReAct 对比点):
 * - 不支持步骤间参数引用(不能 `{{prev.id}}`),LLM 在 plan 阶段必须给出完整 args
 * - 不支持失败回退到 ReAct(工具失败把 error 字符串塞 synth 输入让 LLM 处理)
 * - plan 阶段也走 streamEvents 是为了 thinkSplit 复用 + abort 透传,代价多一次 streaming round trip
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { AIMessageChunk } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AppConfig } from '../config.js'
import {
  type AgUiEvent,
  type Source,
  type PlanStep,
  createRunStarted,
  createRunFinished,
  createRunError,
  createStepStarted,
  createStepFinished,
  createTextMessageStart,
  createTextMessageContent,
  createTextMessageEnd,
  createThinkingStart,
  createThinkingContent,
  createThinkingEnd,
  createToolCallStart,
  createToolCallArgs,
  createToolCallEnd,
  createToolCallResult,
  createPlanGenerated
} from './ag-ui.js'
import type { ChatMessage, ResumeItem, TokenUsage } from './llm.js'
import { buildChatModel } from './langgraph-agent.js'
import { type AdapterLogger } from './langgraphToAgUi.js'
import {
  createThinkSplitState,
  feedThinkSplit,
  flushThinkSplit,
  type ThinkSplitState
} from './thinkSplit.js'

// ── Plan 数据模型 ──

// Task 4.4:工具名从 MCP 动态发现,不再硬编码 enum
function buildPlanSchema(toolNames: string[]) {
  const PlanStepSchema = z.object({
    id: z.string().min(1),
    goal: z.string().min(1),
    tool: z.string().refine(name => toolNames.includes(name), {
      message: `tool must be one of: ${toolNames.join(', ')}`
    }),
    args: z.record(z.string(), z.unknown())
  })
  return z.object({
    rationale: z.string(),
    steps: z.array(PlanStepSchema).min(1).max(10)
  })
}

type Plan = { rationale: string; steps: Array<{ id: string; goal: string; tool: string; args: Record<string, unknown> }> }

// Task 4.4:plan 阶段 system prompt 从 MCP 工具列表动态生成
function buildPlanSystemPrompt(tools: StructuredToolInterface[]): string {
  const toolList = tools.map(t => ({
    name: t.name,
    description: t.description,
    schema: t.schema ? JSON.parse(JSON.stringify(t.schema)) : {}
  }))
  return [
    '你是任务规划助手。基于用户问题 + 下方工具清单,输出 JSON 格式的步骤计划。',
    '',
    '**严格规则**:',
    '1. 只输出 JSON,不要 markdown 代码块(不要 ```json),不要解释文字',
    '2. 每步必须指定 tool(只能用清单中的工具名) + args(完整值)',
    '3. **不支持引用前一步结果**(args 必须是字面值,不能 {{prev.xxx}})',
    '4. 步骤之间应当相互独立(虽然实际顺序执行)',
    '5. 最多 10 步;尽量拆细但避免冗余',
    '6. 若用户问题只需要 1 步即可解决,输出 1 步即可',
    '',
    'JSON Schema:',
    '{ "rationale": string, "steps": [{ "id": string, "goal": string, "tool": string, "args": object }] }',
    '',
    '工具清单:',
    JSON.stringify(toolList, null, 2)
  ].join('\n')
}

const SYNTH_PROMPT_SUFFIX =
  '\n\n[执行结果汇总,基于此整合回答用户;若有工具返回 error,请如实说明而非编造]'

// ── 主入口 ──

export async function* runPlannerAgent(
  config: AppConfig,
  tools: StructuredToolInterface[],
  messages: ChatMessage[],
  threadId: string,
  runId: string,
  _resume?: ResumeItem[],
  options?: {
    signal?: AbortSignal
    onUsage?: (usage: TokenUsage, round: number) => void
    log?: AdapterLogger
  }
): AsyncGenerator<AgUiEvent> {
  yield createRunStarted(threadId, runId)

  const sourceMap = new Map<string, Source>()
  const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  const model = buildChatModel(config)

  // 抽出原 system / user / history 给 synth 阶段复用
  const userPrompt = lastUserContent(messages)
  const systemPrompt = firstSystemContent(messages)

  try {
    // ─── 阶段 1:PLAN ───
    yield createStepStarted('planning')
    const planResult = await tryPlan(
      model,
      tools,
      userPrompt,
      systemPrompt,
      options,
      (event) => collectUsage(event, totalUsage, options?.onUsage, 0)
    )
    // streaming 期间收集到的 think / text 事件也 yield 出去(plan 阶段也可能 think)
    for (const ev of planResult.events) yield ev

    if (!planResult.ok) {
      yield createRunError(planResult.error, 'PLAN_PARSE_FAILED')
      yield createStepFinished('planning')
      yield createRunFinished(threadId, runId, undefined, totalUsage, [])
      return
    }
    yield createPlanGenerated(planResult.plan)
    options?.log?.info(
      { stepsCount: planResult.plan.steps.length, retries: planResult.retries },
      'plan generated'
    )
    yield createStepFinished('planning')

    // ─── 阶段 2:EXECUTE ───
    const stepOutcomes: Array<{ step: PlanStep; resultText: string; ok: boolean }> = []
    for (const step of planResult.plan.steps) {
      if (options?.signal?.aborted) {
        throw new Error('aborted before tool execution')
      }
      const toolCallId = randomUUID()
      const argsJson = JSON.stringify(step.args)
      const startedAt = Date.now()

      yield createStepStarted('tool_call')
      yield createToolCallStart(toolCallId, step.tool)
      if (argsJson && argsJson !== '{}') yield createToolCallArgs(toolCallId, argsJson)
      yield createToolCallEnd(toolCallId)
      yield createStepFinished('tool_call')

      let resultText = ''
      let ok = true
      try {
        // Task 4.4:直接调用 MCP tool 的 invoke 方法
        const toolInstance = tools.find(t => t.name === step.tool)
        if (!toolInstance) throw new Error(`tool not found: ${step.tool}`)
        const result = await toolInstance.invoke(step.args, { signal: options?.signal })
        resultText = typeof result === 'string' ? result : JSON.stringify(result)
      } catch (err) {
        ok = false
        resultText = JSON.stringify({ error: String(err) })
      }
      stepOutcomes.push({ step, resultText, ok })

      yield createStepStarted('tool_execution')
      yield createToolCallResult(toolCallId, resultText)
      yield createStepFinished('tool_execution')

      // tool finished 日志:复用跟 ReAct adapter 同样的字段格式
      options?.log?.info(
        {
          tool: step.tool,
          toolCallId,
          durationMs: Date.now() - startedAt,
          argsPreview: argsJson.length > 200 ? argsJson.slice(0, 200) + '…' : argsJson,
          resultPreview: resultText.length > 200 ? resultText.slice(0, 200) + '…' : resultText,
          mode: 'plan'
        },
        'tool finished'
      )
    }

    // ─── 阶段 3:SYNTHESIZE ───
    yield createStepStarted('synthesis')
    const synthMessages = [
      new SystemMessage(systemPrompt + SYNTH_PROMPT_SUFFIX),
      new HumanMessage(
        [
          `用户问题:${userPrompt}`,
          '',
          `计划理由:${planResult.plan.rationale}`,
          '',
          '步骤与结果:',
          ...stepOutcomes.map((o, i) =>
            `[${i + 1}] ${o.step.goal} (tool=${o.step.tool}, ok=${o.ok})\n` +
            `    result: ${o.resultText.length > 800 ? o.resultText.slice(0, 800) + '…' : o.resultText}`
          )
        ].join('\n')
      )
    ]
    yield* streamLLMText(model, synthMessages, options, (event) =>
      collectUsage(event, totalUsage, options?.onUsage, 1)
    )
    yield createStepFinished('synthesis')
  } catch (err) {
    yield createRunError(String(err), 'PLANNER_ERROR')
    yield createRunFinished(
      threadId,
      runId,
      undefined,
      totalUsage,
      Array.from(sourceMap.values())
    )
    return
  }

  yield createRunFinished(
    threadId,
    runId,
    { type: 'success' },
    totalUsage,
    Array.from(sourceMap.values())
  )
}

// ── 内部 helper ──

type ChatModelInstance = ReturnType<typeof buildChatModel>

/**
 * plan 阶段尝试 1 次,失败重试 1 次,再败返回 ok=false 让上层报 RUN_ERROR。
 * 不静默 fallback 到 ReAct——失败要暴露,让用户知道 plan 模式跑挂了。
 */
async function tryPlan(
  model: ChatModelInstance,
  tools: StructuredToolInterface[],
  userPrompt: string,
  baseSystemPrompt: string,
  options:
    | { signal?: AbortSignal; log?: AdapterLogger }
    | undefined,
  onChunkEnd: (event: AIMessageChunk) => void
): Promise<
  | { ok: true; plan: Plan; events: AgUiEvent[]; retries: number }
  | { ok: false; error: string; events: AgUiEvent[] }
> {
  const planSystem = buildPlanSystemPrompt(tools)
  const toolNames = tools.map(t => t.name)
  const PlanSchema = buildPlanSchema(toolNames)
  const messages = [
    new SystemMessage(planSystem),
    // 把"用户人格 + 项目业务约束"也带上,让 plan LLM 知道它在做旅游 agent
    new SystemMessage('[业务上下文,仅供参考,你仍要按上面的 JSON 输出格式]\n' + baseSystemPrompt),
    new HumanMessage(userPrompt)
  ]

  let lastError = ''
  const allEvents: AgUiEvent[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    // 收 stream + 累积非 think 内容用于 JSON.parse
    const { events, fullText } = await collectStreamedText(model, messages, options, onChunkEnd)
    allEvents.push(...events)

    // 去 markdown 代码块包装(prompt 已禁止但保险)
    const jsonStr = stripMarkdownFence(fullText.trim())
    try {
      const parsed = JSON.parse(jsonStr)
      const validated = PlanSchema.safeParse(parsed)
      if (validated.success) {
        return { ok: true, plan: validated.data, events: allEvents, retries: attempt }
      }
      lastError = `plan zod failed: ${JSON.stringify(validated.error.flatten())}`
    } catch (e) {
      lastError = `plan JSON parse failed: ${String(e)}; raw="${jsonStr.slice(0, 200)}"`
    }

    options?.log?.warn?.(
      { attempt: attempt + 1, error: lastError },
      'plan parse failed, retrying'
    )
    // retry 时给 LLM 一个明确的错误反馈
    messages.push(
      new HumanMessage(
        `上次输出无法解析(${lastError})。请严格按 JSON Schema 重新输出,只输出 JSON,不要任何文字或代码块包装。`
      )
    )
  }

  return { ok: false, error: lastError, events: allEvents }
}

/**
 * 流式调 LLM,只累积非 think 段为 fullText(供 JSON.parse),think 段产出 THINKING_* 事件
 * 返回事件序列(注意:这些事件由上层 yield;collect 期间不直接 yield)
 */
async function collectStreamedText(
  model: ChatModelInstance,
  messages: (SystemMessage | HumanMessage)[],
  options: { signal?: AbortSignal } | undefined,
  onChunkEnd: (event: AIMessageChunk) => void
): Promise<{ events: AgUiEvent[]; fullText: string }> {
  const events: AgUiEvent[] = []
  let textStarted = false
  let textMsgId = randomUUID()
  let thinkingStarted = false
  let thinkingMsgId = randomUUID()
  let fullText = ''
  let thinkSplitState: ThinkSplitState = createThinkSplitState()
  let lastChunk: AIMessageChunk | null = null

  const stream = await model.stream(messages, { signal: options?.signal })
  for await (const chunk of stream) {
    lastChunk = chunk

    // 通道 1:additional_kwargs.reasoning_content
    const reasoning =
      (chunk.additional_kwargs as { reasoning_content?: string } | undefined)?.reasoning_content ??
      null
    if (reasoning && typeof reasoning === 'string' && reasoning.length > 0) {
      if (!thinkingStarted) {
        thinkingMsgId = randomUUID()
        events.push(createThinkingStart(thinkingMsgId))
        thinkingStarted = true
      }
      events.push(createThinkingContent(thinkingMsgId, reasoning))
    }

    // 通道 2:content 字符串里 <think>...</think>
    const content = typeof chunk.content === 'string' ? chunk.content : ''
    if (content) {
      const { segments, state: newState } = feedThinkSplit(thinkSplitState, content)
      thinkSplitState = newState
      for (const seg of segments) {
        if (seg.kind === 'think') {
          if (!thinkingStarted) {
            thinkingMsgId = randomUUID()
            events.push(createThinkingStart(thinkingMsgId))
            thinkingStarted = true
          }
          events.push(createThinkingContent(thinkingMsgId, seg.value))
        } else {
          if (thinkingStarted) {
            events.push(createThinkingEnd(thinkingMsgId))
            thinkingStarted = false
          }
          if (!textStarted) {
            textMsgId = randomUUID()
            events.push(createTextMessageStart(textMsgId))
            textStarted = true
          }
          fullText += seg.value
          events.push(createTextMessageContent(textMsgId, seg.value))
        }
      }
    }
  }

  // flush 未闭合 think 残留
  const { segments } = flushThinkSplit(thinkSplitState)
  for (const seg of segments) {
    if (seg.kind === 'think') {
      if (!thinkingStarted) {
        thinkingMsgId = randomUUID()
        events.push(createThinkingStart(thinkingMsgId))
        thinkingStarted = true
      }
      events.push(createThinkingContent(thinkingMsgId, seg.value))
    } else {
      if (thinkingStarted) {
        events.push(createThinkingEnd(thinkingMsgId))
        thinkingStarted = false
      }
      if (!textStarted) {
        textMsgId = randomUUID()
        events.push(createTextMessageStart(textMsgId))
        textStarted = true
      }
      fullText += seg.value
      events.push(createTextMessageContent(textMsgId, seg.value))
    }
  }
  if (thinkingStarted) events.push(createThinkingEnd(thinkingMsgId))
  if (textStarted) events.push(createTextMessageEnd(textMsgId))

  if (lastChunk) onChunkEnd(lastChunk)

  return { events, fullText }
}

/**
 * Synth 阶段:实时 yield 流式事件(不像 plan 阶段那样先收集)
 */
async function* streamLLMText(
  model: ChatModelInstance,
  messages: (SystemMessage | HumanMessage)[],
  options: { signal?: AbortSignal } | undefined,
  onChunkEnd: (event: AIMessageChunk) => void
): AsyncGenerator<AgUiEvent> {
  let textStarted = false
  let textMsgId = randomUUID()
  let thinkingStarted = false
  let thinkingMsgId = randomUUID()
  let thinkSplitState: ThinkSplitState = createThinkSplitState()
  let lastChunk: AIMessageChunk | null = null

  const stream = await model.stream(messages, { signal: options?.signal })
  for await (const chunk of stream) {
    lastChunk = chunk

    const reasoning =
      (chunk.additional_kwargs as { reasoning_content?: string } | undefined)?.reasoning_content ??
      null
    if (reasoning && typeof reasoning === 'string' && reasoning.length > 0) {
      if (!thinkingStarted) {
        thinkingMsgId = randomUUID()
        yield createThinkingStart(thinkingMsgId)
        thinkingStarted = true
      }
      yield createThinkingContent(thinkingMsgId, reasoning)
    }

    const content = typeof chunk.content === 'string' ? chunk.content : ''
    if (content) {
      const { segments, state: newState } = feedThinkSplit(thinkSplitState, content)
      thinkSplitState = newState
      for (const seg of segments) {
        if (seg.kind === 'think') {
          if (!thinkingStarted) {
            thinkingMsgId = randomUUID()
            yield createThinkingStart(thinkingMsgId)
            thinkingStarted = true
          }
          yield createThinkingContent(thinkingMsgId, seg.value)
        } else {
          if (thinkingStarted) {
            yield createThinkingEnd(thinkingMsgId)
            thinkingStarted = false
          }
          if (!textStarted) {
            textMsgId = randomUUID()
            yield createTextMessageStart(textMsgId)
            textStarted = true
          }
          yield createTextMessageContent(textMsgId, seg.value)
        }
      }
    }
  }

  const { segments } = flushThinkSplit(thinkSplitState)
  for (const seg of segments) {
    if (seg.kind === 'think') {
      if (!thinkingStarted) {
        thinkingMsgId = randomUUID()
        yield createThinkingStart(thinkingMsgId)
        thinkingStarted = true
      }
      yield createThinkingContent(thinkingMsgId, seg.value)
    } else {
      if (thinkingStarted) {
        yield createThinkingEnd(thinkingMsgId)
        thinkingStarted = false
      }
      if (!textStarted) {
        textMsgId = randomUUID()
        yield createTextMessageStart(textMsgId)
        textStarted = true
      }
      yield createTextMessageContent(textMsgId, seg.value)
    }
  }
  if (thinkingStarted) yield createThinkingEnd(thinkingMsgId)
  if (textStarted) yield createTextMessageEnd(textMsgId)

  if (lastChunk) onChunkEnd(lastChunk)
}

function collectUsage(
  chunk: AIMessageChunk,
  total: TokenUsage,
  onUsage: ((u: TokenUsage, round: number) => void) | undefined,
  round: number
): void {
  // LangChain AIMessageChunk usage 位置同 langgraphToAgUi:usage_metadata 或 response_metadata.usage
  const meta = chunk as unknown as {
    usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
    response_metadata?: {
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
  }
  const raw = meta.usage_metadata ?? meta.response_metadata?.usage
  if (!raw) return
  const u: TokenUsage = {
    promptTokens:
      (raw as { input_tokens?: number; prompt_tokens?: number }).input_tokens ??
      (raw as { prompt_tokens?: number }).prompt_tokens ??
      0,
    completionTokens:
      (raw as { output_tokens?: number; completion_tokens?: number }).output_tokens ??
      (raw as { completion_tokens?: number }).completion_tokens ??
      0,
    totalTokens: (raw as { total_tokens?: number }).total_tokens ?? 0
  }
  if (u.totalTokens === 0) u.totalTokens = u.promptTokens + u.completionTokens
  total.promptTokens += u.promptTokens
  total.completionTokens += u.completionTokens
  total.totalTokens += u.totalTokens
  onUsage?.(u, round)
}

function stripMarkdownFence(s: string): string {
  // 去掉 ```json ... ``` 包装(若有)
  const m = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  return m ? m[1].trim() : s
}

function firstSystemContent(messages: ChatMessage[]): string {
  const sys = messages.find((m) => m.role === 'system')
  return sys && typeof sys.content === 'string' ? sys.content : ''
}

function lastUserContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content
  }
  return ''
}
