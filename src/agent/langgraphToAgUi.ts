/**
 * Task 整合-1 — LangGraph streamEvents v2 → AG-UI 事件翻译器
 *
 * 规划:docs/开发规划.md 整合阶段 Task 整合-1
 *
 * 事件映射:
 * - on_chat_model_start    → STEP_STARTED(generating)(首次)
 * - on_chat_model_stream   → TEXT_MESSAGE_START(首次)/CONTENT/END
 * - on_chat_model_end      → 累加 usage(onUsage 回调)
 * - on_tool_start          → STEP_STARTED(tool_call) + TOOL_CALL_START/ARGS/END
 * - on_tool_end            → STEP_FINISHED(tool_call) + STEP_STARTED(tool_execution)
 *                            + TOOL_CALL_RESULT + STEP_FINISHED(tool_execution)
 * - 流自然结束             → 检测 [ASK_USER] → RUN_FINISHED { outcome, sources, usage }
 * - 流抛错                 → RUN_ERROR + RUN_FINISHED
 *
 * [ASK_USER] 协议保留(在 adapter 层做 parseAskUser):
 * - 沿用 Task 1.x/2.x 设计,前端 / parseAskUser 解析逻辑不变
 * - Task 4.5 完整版会升级到 LangGraph 原生 interrupt() + Command(resume)
 */

import { randomUUID } from 'node:crypto'
import {
  type AgUiEvent,
  type Source,
  type RunFinishedOutcome,
  createRunStarted,
  createRunFinished,
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
  createInterrupt
} from './ag-ui.js'
import type { TokenUsage } from './token-usage.js'
// Task 4.1.A:think 标签跨 chunk 切分状态机
import {
  createThinkSplitState,
  feedThinkSplit,
  flushThinkSplit,
  type ThinkSplitState
} from './thinkSplit.js'

const ASK_USER_PREFIX = '[ASK_USER]'
const OPTIONS_MARKER = '【选项】'

/** 跟 src/agent/llm.ts:parseAskUser 完全一致(故意 dup,避免 llm.ts 退役后引用悬空) */
function parseAskUser(text: string): { isAskUser: boolean; question: string; options: string[] } {
  const trimmed = text.trim()
  if (!trimmed.startsWith(ASK_USER_PREFIX)) return { isAskUser: false, question: '', options: [] }
  const body = trimmed.slice(ASK_USER_PREFIX.length).trim()
  let question = body
  const options: string[] = []
  const optIdx = body.indexOf(OPTIONS_MARKER)
  if (optIdx !== -1) {
    question = body.slice(0, optIdx).trim()
    const optBlock = body.slice(optIdx + OPTIONS_MARKER.length).trim()
    for (const line of optBlock.split('\n')) {
      const m = line.trim().match(/^\d+[.、]\s*(.+)$/)
      if (m) options.push(m[1].trim())
    }
  }
  return { isAskUser: true, question: question || '请补充更多信息', options }
}

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
  yield createRunStarted(ctx.threadId, ctx.runId)

  // ── 状态机 ──
  // text(对外可见的回答)
  let textStarted = false
  let textMsgId = randomUUID()
  let fullContent = ''           // 仅累加 text 段(用于流末 [ASK_USER] 检测 — think 内的 [ASK_USER] 不算)
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
          if (!inToolStep) {
            yield createStepStarted('tool_call')
            inToolStep = true
          }
          const toolName = event.name ?? 'unknown_tool'
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
          break
        }

        // 其他 LangGraph 事件(on_chain_*、on_llm_*、on_retriever_* 等)我们不关心
        default:
          break
      }
    }
  } catch (err) {
    yield createRunError(String(err), 'AGENT_ERROR')
    yield createRunFinished(
      ctx.threadId,
      ctx.runId,
      undefined,
      totalUsage,
      Array.from(ctx.sourceMap.values())
    )
    return
  }

  // ── 流自然结束 → 检测 [ASK_USER] 反问 ──
  const askResult = parseAskUser(fullContent)
  let outcome: RunFinishedOutcome | undefined
  if (askResult.isAskUser) {
    const interrupt = createInterrupt('input_required', askResult.question, {
      metadata: askResult.options.length > 0 ? { options: askResult.options } : undefined
    })
    outcome = { type: 'interrupt', interrupts: [interrupt] }
  }

  yield createRunFinished(ctx.threadId, ctx.runId, outcome, totalUsage, Array.from(ctx.sourceMap.values()))
}
