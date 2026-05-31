import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import { randomUUID } from 'node:crypto'
import { getToolDefinitions, runTool } from './tools.js'
import {
  EventType,
  type AgUiEvent,
  type RunFinishedOutcome,
  type Source,
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
} from './ag-ui.js' //NOTE: 在runAgentStream中进行的openAI返回Chunks到ag-ui协议的转义
import { type TokenUsage, accumulateUsage, estimateTokens } from './token-usage.js'

export type { TokenUsage }

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
    role: 'assistant'
    content: string | null
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
  }
  | { role: 'tool'; tool_call_id: string; content: string }

function chatUrl(config: AppConfig): string {
  return `${config.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`
}

// ─── 流式请求：解析 OpenAI SSE ───
type StreamChunk = {
  choices?: Array<{
    finish_reason: string | null
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  // Task 1.2 / 八股 08 §2.2：仅在请求体声明 stream_options.include_usage=true 时下发，
  // 通常只出现在最后一个 chunk（choices 为空数组）。OpenAI 协议为 snake_case，
  // 进入业务层前会在 runAgentStream 转成 camelCase（见 token-usage.ts）
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * postChatStream — 流式调用 OpenAI 兼容 /chat/completions
 *
 * 规划：Task 1.1（SSE 流式） + Task 1.2（usage 透传）
 * 八股：
 * - 09-Prompt工程.md §2.4 推理参数（temperature/top_p/max_tokens 在请求体透传）
 * - 08-工程化实践.md §1 模型路由与容错（超时控制） / §2.2 Token 计数（stream_options）
 *
 * 实现要点：
 * - 显式 stream_options.include_usage：流式默认不返回 usage，必须主动声明
 * - AbortSignal 串到 fetch：客户端断开 → controller.abort → 立即停止上游消耗
 * - 解析层 try/catch：单个坏 chunk 不应让整条流崩溃，八股 08 §3 强调可观测要"降级而非中断"
 * - 兼容 CRLF 与 SSE 注释行（":" 开头是心跳/注释，需跳过）
 */
async function* postChatStream(
  config: AppConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal
): AsyncGenerator<StreamChunk> {
  // 八股 08 §1.2：即使外层有 abort，fetch 自身也应有超时兜底
  const timeoutCtl = new AbortController()
  const timer = setTimeout(() => timeoutCtl.abort(), config.LLM_REQUEST_TIMEOUT_MS)
  const linkedSignal = signal
    ? anySignal([signal, timeoutCtl.signal])
    : timeoutCtl.signal

  let res: Response
  try {
    res = await fetch(chatUrl(config), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...body,
        stream: true,
        // Task 1.2：让最后一个 chunk 带回 usage
        stream_options: { include_usage: true }
      }),
      signal: linkedSignal
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const t = await res.text()
    throw new Error(`chat/completions stream ${res.status}: ${t}`)
  }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      // 客户端断开后立即中止读取，避免继续从远端拉数据
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // 兼容 CRLF / LF
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // SSE 注释/心跳行以 ":" 开头，跳过
        if (trimmed.startsWith(':')) continue
        if (trimmed === 'data: [DONE]') continue
        if (!trimmed.startsWith('data: ')) continue
        const payload = trimmed.slice(6)
        try {
          yield JSON.parse(payload) as StreamChunk
        } catch {
          // 八股 08 §3.2：单条坏数据应记录但不中断流；此处保持沉默由上层日志兜底
          continue
        }
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* ignore */ }
  }
}

/** 多 AbortSignal 合并：任一触发即整体 abort */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctl = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort()
      break
    }
    s.addEventListener('abort', () => ctl.abort(), { once: true })
  }
  return ctl.signal
}

// ─── [ASK_USER] 标记检测 ───
const ASK_USER_PREFIX = '[ASK_USER]'
const OPTIONS_MARKER = '【选项】'

function parseAskUser(text: string): { isAskUser: boolean; question: string; options: string[] } {
  const trimmed = text.trim()
  if (!trimmed.startsWith(ASK_USER_PREFIX)) {
    return { isAskUser: false, question: '', options: [] }
  }

  const body = trimmed.slice(ASK_USER_PREFIX.length).trim()

  // 尝试分离问题与选项
  let question = body
  let options: string[] = []

  const optIdx = body.indexOf(OPTIONS_MARKER)
  if (optIdx !== -1) {
    question = body.slice(0, optIdx).trim()
    const optBlock = body.slice(optIdx + OPTIONS_MARKER.length).trim()
    // 按行解析：匹配 "1. xxx" "2. xxx" 或 "1、xxx" 格式
    const lines = optBlock.split('\n')
    for (const line of lines) {
      const m = line.trim().match(/^\d+[.、]\s*(.+)$/)
      if (m) {
        options.push(m[1].trim())
      }
    }
  }

  return { isAskUser: true, question: question || '请补充更多信息', options }
}

// ─── Resume 类型 ───
export type ResumeItem = {
  interruptId: string
  status: 'resolved' | 'cancelled'
  payload?: Record<string, unknown>
}

/**
 * runAgentStream — 多轮 ReAct 循环 + AG-UI 事件流
 *
 * 规划：Task 1.1 流式输出 / Task 1.2 token 计数 / 阶段4 Task 4.1 ReAct 可观测
 * 八股：
 * - 02-核心框架.md ReAct 循环
 * - 08-工程化实践.md §2 Token 成本 / §3 全链路可观测
 *
 * 入参 options.signal：上游（HTTP handler）监听 req close 后 abort，
 * 确保客户端断开立即停止 LLM 调用，避免空跑产生 token 费用。
 *
 * 入参 options.onUsage：每轮 LLM 结束后回调一次（含 fallback 估算），
 * 上层用它打日志或做实时观测；总 usage 也会随 RUN_FINISHED 事件下发，
 * 便于事件订阅者（前端 UI / DB 持久化）一次性拿到聚合结果。
 */
export async function* runAgentStream(
  pool: DbPool,
  config: AppConfig,
  messages: ChatMessage[],
  threadId: string,
  runId: string,
  resume?: ResumeItem[],
  options?: {
    signal?: AbortSignal
    onUsage?: (usage: TokenUsage, round: number) => void
  }
): AsyncGenerator<AgUiEvent> {
  yield createRunStarted(threadId, runId)

  const tools = getToolDefinitions()
  const referenced = new Set<number>()
  let current: ChatMessage[] = [...messages]
  const signal = options?.signal
  let totalUsage: TokenUsage | null = null
  // Task 3.5:跨多轮工具调用聚合 sources(同 destinationId 取首次出现,via 保留首次的工具)
  const sourceMap = new Map<number, Source>()

  try {
    for (let round = 0; round < config.LLM_MAX_TOOL_ROUNDS; round++) {
      if (signal?.aborted) break
      const stream = postChatStream(
        config,
        {
          model: config.OPENAI_MODEL,
          messages: current,
          tools,
          tool_choice: 'auto',
          // Task 1.1 / 八股 09 §2.4：推理参数全量透传
          temperature: config.LLM_TEMPERATURE,
          top_p: config.LLM_TOP_P,
          max_tokens: config.LLM_MAX_TOKENS
        },
        signal
      )

      let assistantContent = ''
      const collectedToolCalls: Array<{
        id: string
        name: string
        args: string
      }> = []
      let activeToolCallId = ''
      let activeToolCallName = ''
      let activeToolCallArgs = ''
      let msgId = randomUUID()
      let textStarted = false
      let toolStepStarted = false
      let lastUsage: TokenUsage | null = null

      for await (const chunk of stream) {
        // Task 1.2 / 八股 08 §2.2：usage 通常出现在最后一个 chunk（choices 为空）
        // 协议层 snake_case → 业务层 camelCase 的边界转换
        if (chunk.usage) {
          lastUsage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens
          }
        }
        const delta = chunk.choices?.[0]?.delta
        const finishReason = chunk.choices?.[0]?.finish_reason

        // 文本内容
        if (delta?.content) {
          if (!textStarted) {
            yield createStepStarted('generating')
            yield createTextMessageStart(msgId)
            textStarted = true
          }
          assistantContent += delta.content
          yield createTextMessageContent(msgId, delta.content)
        }

        // 工具调用
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              // 关闭上一个未结束的 tool call
              if (activeToolCallId && activeToolCallId !== tc.id) {
                yield createToolCallEnd(activeToolCallId)
                collectedToolCalls.push({
                  id: activeToolCallId,
                  name: activeToolCallName,
                  args: activeToolCallArgs
                })
              }
              if (!toolStepStarted) {
                // 关闭可能未关闭的文本消息
                if (textStarted) {
                  yield createTextMessageEnd(msgId)
                  yield createStepFinished('generating')
                  textStarted = false
                }
                yield createStepStarted('tool_call')
                toolStepStarted = true
              }
              activeToolCallId = tc.id
              activeToolCallName = tc.function?.name ?? ''
              activeToolCallArgs = ''
              yield createToolCallStart(tc.id, activeToolCallName)
            }
            if (tc.function?.arguments) {
              activeToolCallArgs += tc.function.arguments
              yield createToolCallArgs(activeToolCallId, tc.function.arguments)
            }
          }
        }

        // 流结束
        if (finishReason === 'stop' || finishReason === 'tool_calls') {
          if (textStarted) {
            yield createTextMessageEnd(msgId)
            yield createStepFinished('generating')
            textStarted = false
          }
          if (activeToolCallId) {
            yield createToolCallEnd(activeToolCallId)
            collectedToolCalls.push({
              id: activeToolCallId,
              name: activeToolCallName,
              args: activeToolCallArgs
            })
            activeToolCallId = ''
          }
          if (toolStepStarted) {
            yield createStepFinished('tool_call')
            toolStepStarted = false
          }
        }
      }

      // Task 1.2：API 未返回 usage 时降级估算（部分兼容协议不支持 stream_options）
      const roundUsage: TokenUsage = lastUsage ?? (() => {
        const promptText = current
          .map(m => {
            if (m.role === 'tool') return m.content
            if (m.role === 'assistant') return m.content ?? ''
            return m.content
          })
          .join('\n')
        const promptTokens = estimateTokens(promptText)
        const completionTokens = estimateTokens(assistantContent)
        return {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        }
      })()
      totalUsage = accumulateUsage(totalUsage, roundUsage)
      options?.onUsage?.(roundUsage, round)

      // 有工具调用 → 执行
      if (collectedToolCalls.length > 0) {
        current.push({
          role: 'assistant',
          content: assistantContent || null,
          tool_calls: collectedToolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.args }
          }))
        })
        for (const tc of collectedToolCalls) {
          try {
            const result = await runTool(pool, config, tc.name, tc.args)
            for (const id of result.referencedDestinationIds) {
              referenced.add(id)
            }
            // Task 3.5:聚合 source(以 destinationId 去重,保留首次记录的 via)
            if (result.sources) {
              for (const s of result.sources) {
                if (!sourceMap.has(s.destinationId)) sourceMap.set(s.destinationId, s)
              }
            }
            yield createStepStarted('tool_execution')
            yield createToolCallResult(tc.id, result.text)
            yield createStepFinished('tool_execution')
            current.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: result.text
            })
          } catch (err) {
            const errMsg = JSON.stringify({ error: String(err) })
            yield createStepStarted('tool_execution')
            yield createToolCallResult(tc.id, errMsg)
            yield createStepFinished('tool_execution')
            current.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: errMsg
            })
          }
        }
        continue
      }

      // 无工具调用 → 检查是否为 [ASK_USER] 反问
      const askResult = parseAskUser(assistantContent)
      if (askResult.isAskUser) {
        const interrupt = createInterrupt('input_required', askResult.question, {
          metadata: askResult.options.length > 0 ? { options: askResult.options } : undefined
        })
        const outcome: RunFinishedOutcome = { type: 'interrupt', interrupts: [interrupt] }
        yield createRunFinished(threadId, runId, outcome, totalUsage ?? undefined, Array.from(sourceMap.values()))
        return
      }

      // 正常文本回答 → 结束
      break
    }
  } catch (err) {
    yield createRunError(String(err), 'AGENT_ERROR')
  }

  yield createRunFinished(threadId, runId, undefined, totalUsage ?? undefined, Array.from(sourceMap.values()))
}
