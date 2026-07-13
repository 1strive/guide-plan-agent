/**
 * Task 整合-1 + Task 4.5 — LangGraph streamEvents v2 → AG-UI 事件翻译器
 *
 * 规划:docs/开发规划.md 整合阶段 Task 整合-1 + Task 4.5
 *
 * 事件映射:
 * - on_chat_model_start    → STEP_STARTED(generating)(首次)
 * - on_chat_model_stream   → TEXT_MESSAGE_START(首次)/CONTENT/END
 * - on_chat_model_end      → 累加 usage(onUsage 回调)
 * - on_tool_start          → STEP_STARTED(tool_call) + TOOL_CALL_START/ARGS/END
 * - on_tool_end            → STEP_FINISHED(tool_call) + STEP_STARTED(tool_execution)
 *                            + TOOL_CALL_RESULT + STEP_FINISHED(tool_execution)
 * - 流自然结束             → (caller 负责发 RUN_FINISHED，本层不发)
 * - 流抛错                 → RUN_ERROR (caller 发 RUN_FINISHED)
 *
 * Task 4.5 改造:
 * - 移除 [ASK_USER] 文本协议解析(parseAskUser)
 * - 移除 RUN_STARTED/RUN_FINISHED 发射(交给 caller 统一管理)
 * - 过滤 ask_user 工具的 TOOL_CALL 事件(内部机制，不暴露给前端)
 * - 通过 streamCtx 向 caller 回传 usage/sources
 */

import { randomUUID } from 'node:crypto'
import {
  type AgUiEvent,
  type Source,
  type MapRouteEvent,
  createRunError,
  createStepStarted,
  createStepFinished,
  createTextMessageStart,
  createTextMessageContent,
  createTextMessageEnd,
  createToolCallStart,
  createToolCallArgs,
  createToolCallEnd,
  createToolCallResult,
  createThinkingStart,
  createThinkingContent,
  createThinkingEnd,
  createMapRoute
} from './ag-ui.js'
import type { TokenUsage } from './token-usage.js'
import type { StreamContext } from './langgraph-agent.js'
import {
  createThinkSplitState,
  feedThinkSplit,
  flushThinkSplit,
  type ThinkSplitState
} from './thinkSplit.js'

// Task 4.5:移除旧的 [ASK_USER] 文本协议解析，改用 LangGraph 原生 interrupt
// ask_user 工具的 run_id 跟踪集合（用于过滤内部工具事件）
const ASK_USER_TOOL_NAME = 'ask_user'
// 路线改造:plan_route 工具输出路线三要素，adapter 在 on_tool_end 拦截转 MAP_ROUTE
const PLAN_ROUTE_TOOL_NAME = 'plan_route'

// Task 4.1.B:可选 logger 接口(对齐 pino,只用 info 一层即够;不强依赖 pino,便于单测注入 stub)
export type AdapterLogger = {
  info(obj: Record<string, unknown>, msg?: string): void
  warn?(obj: Record<string, unknown>, msg?: string): void
}

type Ctx = {
  threadId: string
  runId: string
  sourceMap: Map<string, Source>
  onUsage?: (usage: TokenUsage, round: number) => void
  // Task 4.1.B:工具调用 timing 日志的输出 logger;未传则 silently 跳过日志
  log?: AdapterLogger
  // Task 4.5:共享上下文，由 caller 传入，adapter 填充 usage 数据
  streamCtx?: StreamContext
}

/**
 * LangGraph streamEvents v2 事件的 shape(简化版,我们只用到 event/name/data/run_id 几个字段)
 */
type LgEvent = {
  event: string
  name?: string
  run_id?: string
  data?: {
    // Task 4.1:additional_kwargs.reasoning_content 是 DeepSeek/xAI/OpenRouter 等"独立 reasoning 字段"协议
    // LangChain 在 @langchain/openai/converters/completions.js:264 自动搬到这里
    chunk?: {
      content?: string | unknown
      additional_kwargs?: { reasoning_content?: string }
    }
    input?: unknown
    output?: unknown
  }
  // 其他字段(metadata、tags 等)用不到
}

export async function* translateLangGraphStream(
  stream: AsyncIterable<LgEvent>,
  ctx: Ctx
): AsyncGenerator<AgUiEvent> {
  // Task 4.5:RUN_STARTED / RUN_FINISHED 由 caller(langgraph-agent.ts)统一发射
  // 本层只负责翻译中间事件(text/thinking/tool)

  // ── 状态机 ──
  // text(对外可见的回答)
  let textStarted = false
  let textMsgId = randomUUID()
  let fullContent = ''           // 仅累加 text 段
  // thinking(reasoning 过程,跟 text 平行的事件流)
  let thinkingStarted = false
  let thinkingMsgId = randomUUID()
  // Task 4.1.A:think 标签状态机(跨 chunk 缓冲)
  let thinkSplitState: ThinkSplitState = createThinkSplitState()
  // step 嵌套
  let inGeneratingStep = false
  let inToolStep = false
  let round = 0
  const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  // Task 4.1.B:每个 tool_call run_id → start 时间戳,end 时算 durationMs
  const toolStart = new Map<string, { name: string; startedAt: number; argsPreview: string }>()

  try {
    for await (const event of stream) {
      const eventName = event.event
      const data = event.data ?? {}

      switch (eventName) {
        case 'on_chat_model_start':
          round++
          if (!inGeneratingStep) {
            yield createStepStarted('generating')
            inGeneratingStep = true
          }
          break

        case 'on_chat_model_stream': {
          const chunk = data.chunk as
            | { content?: string | unknown; additional_kwargs?: { reasoning_content?: string } }
            | undefined

          // Task 4.1.A 通道 1:LangChain 标准 reasoning_content(DeepSeek/xAI/OpenRouter 自动搬到这里)
          // 兜底 fallback(reasoning_content): 部分协议直接挂 chunk.reasoning_content
          const reasoning =
            chunk?.additional_kwargs?.reasoning_content ??
            (chunk as { reasoning_content?: string } | undefined)?.reasoning_content ??
            null
          if (reasoning && typeof reasoning === 'string' && reasoning.length > 0) {
            if (!thinkingStarted) {
              thinkingMsgId = randomUUID()
              yield createThinkingStart(thinkingMsgId)
              thinkingStarted = true
            }
            yield createThinkingContent(thinkingMsgId, reasoning)
          }

          // Task 4.1.A 通道 2:content 里内联 <think>...</think>(MiniMax 走这条)
          const content = typeof chunk?.content === 'string' ? chunk.content : ''
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
                // text 段:think 边界后接到 text → 若 thinking 还开着,先关闭
                if (thinkingStarted) {
                  yield createThinkingEnd(thinkingMsgId)
                  thinkingStarted = false
                }
                if (!textStarted) {
                  textMsgId = randomUUID()
                  yield createTextMessageStart(textMsgId)
                  textStarted = true
                }
                fullContent += seg.value
                yield createTextMessageContent(textMsgId, seg.value)
              }
            }
          }
          break
        }

        case 'on_chat_model_end': {
          // Task 4.1.A:flush thinkSplit 残留(未闭合的 <th 等)
          const { segments } = flushThinkSplit(thinkSplitState)
          thinkSplitState = createThinkSplitState()
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
              fullContent += seg.value
              yield createTextMessageContent(textMsgId, seg.value)
            }
          }
          // 双流都收尾(未闭合 thinking 也要发 END,前端才能停"思考中"动画)
          if (thinkingStarted) {
            yield createThinkingEnd(thinkingMsgId)
            thinkingStarted = false
          }
          if (textStarted) {
            yield createTextMessageEnd(textMsgId)
            textStarted = false
          }
          if (inGeneratingStep) {
            yield createStepFinished('generating')
            inGeneratingStep = false
          }
          // usage 提取:LangChain 把它放在 output.usage_metadata 或 output.response_metadata.usage
          const output = data.output as
            | {
              usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
              response_metadata?: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }
            }
            | undefined
          const usage = output?.usage_metadata ?? output?.response_metadata?.usage
          if (usage) {
            const u: TokenUsage = {
              promptTokens:
                (usage as { input_tokens?: number; prompt_tokens?: number }).input_tokens ??
                (usage as { prompt_tokens?: number }).prompt_tokens ??
                0,
              completionTokens:
                (usage as { output_tokens?: number; completion_tokens?: number }).output_tokens ??
                (usage as { completion_tokens?: number }).completion_tokens ??
                0,
              totalTokens: (usage as { total_tokens?: number }).total_tokens ?? 0
            }
            if (u.totalTokens === 0) u.totalTokens = u.promptTokens + u.completionTokens
            totalUsage.promptTokens += u.promptTokens
            totalUsage.completionTokens += u.completionTokens
            totalUsage.totalTokens += u.totalTokens
            ctx.onUsage?.(u, round - 1)
          }
          break
        }

        case 'on_tool_start': {
          const toolName = event.name ?? 'unknown_tool'
          // Task 4.5:过滤 ask_user 工具事件（内部机制，不暴露给前端）
          if (toolName === ASK_USER_TOOL_NAME) break
          if (!inToolStep) {
            yield createStepStarted('tool_call')
            inToolStep = true
          }
          const toolCallId = event.run_id ?? randomUUID()
          const input = data.input
          const args = typeof input === 'string' ? input : JSON.stringify(input ?? {})
          // Task 4.1.B:记 timing,end 时算 durationMs;args 截 200 字符防爆日志
          toolStart.set(toolCallId, {
            name: toolName,
            startedAt: Date.now(),
            argsPreview: args.length > 200 ? args.slice(0, 200) + '…' : args
          })
          yield createToolCallStart(toolCallId, toolName)
          if (args && args !== '{}') yield createToolCallArgs(toolCallId, args)
          yield createToolCallEnd(toolCallId)
          break
        }

        case 'on_tool_end': {
          // Task 4.5：过滤 ask_user 工具的 end 事件
          if (event.name === ASK_USER_TOOL_NAME) break
          const toolName = event.name ?? 'unknown_tool'
          const toolCallId = event.run_id ?? randomUUID()
          const output = data.output
          const text =
            typeof output === 'string'
              ? output
              : (output as { content?: string })?.content ?? JSON.stringify(output)
          // Task 4.1.B:输出工具调用耗时日志(runId 由 ctx.log 自带 child binding)
          const started = toolStart.get(toolCallId)
          if (started) {
            const durationMs = Date.now() - started.startedAt
            const resultStr = String(text)
            ctx.log?.info(
              {
                tool: started.name,
                toolCallId,
                durationMs,
                argsPreview: started.argsPreview,
                resultPreview: resultStr.length > 200 ? resultStr.slice(0, 200) + '…' : resultStr
              },
              'tool finished'
            )
            toolStart.delete(toolCallId)
          }
          if (inToolStep) {
            yield createStepFinished('tool_call')
            inToolStep = false
          }
          yield createStepStarted('tool_execution')
          yield createToolCallResult(toolCallId, String(text))
          yield createStepFinished('tool_execution')

          // 路线渲染：plan_route 工具输出路线三要素（出发地/目的地/出行方式），
          // 解析后组装成有序 points（名称形式）下发 MAP_ROUTE，前端用 AMap 名称形式检索渲染。
          // 八股 04 §6 MCP 协议：坐标解析交给前端 AMap JS API，后端只传地点名称 + 城市
          if (toolName === PLAN_ROUTE_TOOL_NAME) {
            const intent = parsePlanRouteOutput(output)
            if (intent) {
              // 有序路线点：首=起点、末=终点、中间=途经点；环线在末尾补回起点
              const points: Array<{ name: string; city?: string }> = [
                { name: intent.origin, city: intent.city },
                ...intent.destinations.map((name) => ({ name, city: intent.city }))
              ]
              if (intent.isLoop) points.push({ name: intent.origin, city: intent.city })
              yield createMapRoute(randomUUID(), intent.mode, undefined, {
                points,
                isLoop: intent.isLoop,
                originName: intent.origin,
                destinationName: intent.destinations[intent.destinations.length - 1],
                city: intent.city
              })
              ctx.log?.info(
                { tool: toolName, toolCallId, points: points.length, mode: intent.mode },
                'plan route emitted'
              )
            }
          }
          break
        }

        // 其他 LangGraph 事件(on_chain_*、on_llm_*、on_retriever_* 等)我们不关心
        default:
          break
      }
    }
  } catch (err) {
    // Task 4.5：错误只 yield RUN_ERROR，RUN_FINISHED 由 caller 负责
    yield createRunError(String(err), 'AGENT_ERROR')
    return
  }

  // Task 4.5：流自然结束 → 将累计 usage 回传给 caller（通过 streamCtx）
  if (ctx.streamCtx) {
    ctx.streamCtx.totalUsage.promptTokens += totalUsage.promptTokens
    ctx.streamCtx.totalUsage.completionTokens += totalUsage.completionTokens
    ctx.streamCtx.totalUsage.totalTokens += totalUsage.totalTokens
  }
}

// plan_route 工具输出（JSON 字符串）→ 路线意图对象；解析失败返回 null 不发事件
type PlanRouteIntent = {
  origin: string
  destinations: string[]
  mode: MapRouteEvent['mode']
  city?: string
  isLoop?: boolean
}

function parsePlanRouteOutput(output: unknown): PlanRouteIntent | null {
  try {
    // on_tool_end 的 output 可能是字符串，也可能被包成 { content: '<json>' }
    const raw =
      typeof output === 'string'
        ? output
        : (output as { content?: string } | null)?.content
    if (typeof raw !== 'string') return null
    const obj = JSON.parse(raw) as Partial<PlanRouteIntent>
    if (!obj.origin || !Array.isArray(obj.destinations) || obj.destinations.length === 0) return null
    if (!obj.mode) return null
    return {
      origin: obj.origin,
      destinations: obj.destinations,
      mode: obj.mode,
      city: obj.city,
      isLoop: !!obj.isLoop
    }
  } catch {
    return null
  }
}
