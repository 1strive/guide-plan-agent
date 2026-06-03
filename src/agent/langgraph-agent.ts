/**
 * Task 整合-1 + Task 4.4 — LangGraph 主线 Agent
 *
 * 规划:docs/开发规划.md 整合阶段 Task 整合-1 + 阶段4 Task 4.4
 * 八股:02-核心框架.md §6 LangGraph 状态机 / Q9~Q11 何时选 LangGraph
 *       04-工具调用.md §6 MCP 协议(Task 4.4:工具从 MCP Server 动态发现)
 *
 * Task 4.4 改造要点:
 * - 删除 buildTools / runTool / sourceKey(本地 SQL 工具已删除)
 * - tools 参数由调用方(runManager)传入 MCP 工具列表
 * - createAgent 直接使用 MCP StructuredTool[],运行时动态发现
 */

import { createAgent } from 'langchain'
import { MemorySaver } from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AppConfig } from '../config.js'
import type { AgUiEvent, Source } from './ag-ui.js'
import type { ChatMessage, ResumeItem, TokenUsage } from './llm.js'
import { translateLangGraphStream, type AdapterLogger } from './langgraphToAgUi.js'

const checkpointer = new MemorySaver()

export function buildChatModel(config: AppConfig): ChatOpenAI {
  return new ChatOpenAI({
    model: config.OPENAI_MODEL,
    apiKey: config.OPENAI_API_KEY,
    configuration: { baseURL: config.OPENAI_BASE_URL },
    temperature: config.LLM_TEMPERATURE,
    topP: config.LLM_TOP_P,
    maxTokens: config.LLM_MAX_TOKENS,
    streaming: true,
    streamUsage: true
  })
}

/**
 * Task 4.4:tools 参数从 MCP Manager 获取,不再本地构建
 */
export async function* runLangGraphAgent(
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
  const sourceMap = new Map<string, Source>()
  const model = buildChatModel(config)

  const systemMsg = messages.find((m) => m.role === 'system')
  const otherMsgs = messages.filter((m) => m.role !== 'system')
  const systemPrompt = systemMsg && typeof systemMsg.content === 'string' ? systemMsg.content : undefined

  const agent = createAgent({
    model,
    tools,
    systemPrompt,
    checkpointer
  })

  const input = { messages: otherMsgs.map(toLangChainMessage) }
  const stream = agent.streamEvents(input, {
    version: 'v2',
    configurable: { thread_id: runId },
    signal: options?.signal
  })

  yield* translateLangGraphStream(stream, {
    threadId,
    runId,
    sourceMap,
    onUsage: options?.onUsage,
    log: options?.log
  })
}

function toLangChainMessage(m: ChatMessage): { role: string; content: string; tool_call_id?: string } {
  if (m.role === 'user') return { role: 'user', content: m.content }
  if (m.role === 'assistant') return { role: 'assistant', content: m.content ?? '' }
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id }
  return { role: 'system', content: m.content }
}
