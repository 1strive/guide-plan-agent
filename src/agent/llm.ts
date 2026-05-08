import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import { randomUUID } from 'node:crypto'
import { getToolDefinitions, runTool } from './tools.js'
import {
  EventType,
  type AgUiEvent,
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
  createToolCallResult
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

type ChatCompletionResponse = {
  choices: Array<{
    finish_reason: string
    message: ChatMessage
  }>
}

function chatUrl(config: AppConfig): string {
  return `${config.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`
}

async function postChat(
  config: AppConfig,
  body: Record<string, unknown>
): Promise<ChatCompletionResponse> {
  const res = await fetch(chatUrl(config), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`chat/completions ${res.status}: ${t}`)
  }
  return (await res.json()) as ChatCompletionResponse
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

export async function runAgentWithTools(
  pool: DbPool,
  config: AppConfig,
  messages: ChatMessage[]
): Promise<{ content: string; referencedDestinationIds: number[] }> {
  const tools = getToolDefinitions()
  const referenced = new Set<number>()
  let current: ChatMessage[] = [...messages]
  const maxRounds = config.LLM_MAX_TOOL_ROUNDS

  for (let round = 0; round < maxRounds; round++) {
    const resp = await postChat(config, {
      model: config.OPENAI_MODEL,
      messages: current,
      tools,
      tool_choice: 'auto',
      temperature: 0.4
    })
    const choice = resp.choices[0]
    if (!choice) {
      throw new Error('empty choices from LLM')
    }
    const msg = choice.message
    if (msg.role !== 'assistant') {
      throw new Error('expected assistant message')
    }
    const toolCalls = msg.tool_calls
    if (toolCalls && toolCalls.length > 0) {
      current.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: toolCalls
      })
      for (const tc of toolCalls) {
        const name = tc.function.name
        const args = tc.function.arguments ?? '{}'
        try {
          const result = await runTool(pool, config, name, args)
          for (const id of result.referencedDestinationIds) {
            referenced.add(id)
          }
          current.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result.text
          })
        } catch (err) {
          current.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: String(err) })
          })
        }
      }
      continue
    }
    const text = msg.content?.trim() ?? ''
    return {
      content: text,
      referencedDestinationIds: [...referenced]
    }
  }

  throw new Error('tool loop exceeded LLM_MAX_TOOL_ROUNDS')
}

// ─── 流式 Agent：yield AG-UI 事件 ───
export async function* runAgentStream(
  pool: DbPool,
  config: AppConfig,
  messages: ChatMessage[],
  threadId: string,
  runId: string
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

      // 无工具调用 → 结束
      break
    }
  } catch (err) {
    yield createRunError(String(err), 'AGENT_ERROR')
  }

  yield createRunFinished(threadId, runId)
}
