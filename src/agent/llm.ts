import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import { randomUUID } from 'node:crypto'
import { getToolDefinitions, runTool } from './tools.js'
import {
  EventType,
  type AgUiEvent,
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
  choices: Array<{
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
}

async function* postChatStream(
  config: AppConfig,
  body: Record<string, unknown>
): AsyncGenerator<StreamChunk> {
  const res = await fetch(chatUrl(config), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ...body, stream: true })
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`chat/completions stream ${res.status}: ${t}`)
  }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'data: [DONE]') continue
      if (trimmed.startsWith('data: ')) {
        yield JSON.parse(trimmed.slice(6))
      }
    }
  }
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

// ─── 流式 Agent：yield AG-UI 事件 ───
export async function* runAgentStream(
  pool: DbPool,
  config: AppConfig,
  messages: ChatMessage[],
  threadId: string,
  runId: string,
  resume?: ResumeItem[]
): AsyncGenerator<AgUiEvent> {
  yield createRunStarted(threadId, runId)

  const tools = getToolDefinitions()
  const referenced = new Set<number>()
  let current: ChatMessage[] = [...messages]

  try {
    for (let round = 0; round < config.LLM_MAX_TOOL_ROUNDS; round++) {
      const stream = postChatStream(config, {
        model: config.OPENAI_MODEL,
        messages: current,
        tools,
        tool_choice: 'auto',
        temperature: config.LLM_TEMPERATURE
      })

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

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        const finishReason = chunk.choices[0]?.finish_reason

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
        yield createRunFinished(threadId, runId, outcome)
        return
      }

      // 正常文本回答 → 结束
      break
    }
  } catch (err) {
    yield createRunError(String(err), 'AGENT_ERROR')
  }

  yield createRunFinished(threadId, runId)
}
