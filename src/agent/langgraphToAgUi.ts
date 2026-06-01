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
  createInterrupt
} from './ag-ui.js'
import type { TokenUsage } from './token-usage.js'

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

type Ctx = {
  threadId: string
  runId: string
  // Task 3.7:key 改 string 以兼容 destination(dest-id)与 url(url-地址)两类 source
  sourceMap: Map<string, Source>
  onUsage?: (usage: TokenUsage, round: number) => void
}

/**
 * LangGraph streamEvents v2 事件的 shape(简化版,我们只用到 event/name/data/run_id 几个字段)
 */
type LgEvent = {
  event: string
  name?: string
  run_id?: string
  data?: {
    chunk?: { content?: string | unknown }
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

  // 状态机
  let textStarted = false
  let msgId = randomUUID()
  let fullContent = ''           // 收集本轮 text(用于流末 [ASK_USER] 检测)
  let inGeneratingStep = false
  let inToolStep = false
  let round = 0
  const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

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
          const chunk = data.chunk as { content?: string | unknown } | undefined
          const content = typeof chunk?.content === 'string' ? chunk.content : ''
          if (content) {
            if (!textStarted) {
              msgId = randomUUID()
              yield createTextMessageStart(msgId)
              textStarted = true
            }
            fullContent += content
            yield createTextMessageContent(msgId, content)
          }
          break
        }

        case 'on_chat_model_end': {
          if (textStarted) {
            yield createTextMessageEnd(msgId)
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
