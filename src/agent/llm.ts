import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import { getToolDefinitions, runTool } from './tools.js'

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
