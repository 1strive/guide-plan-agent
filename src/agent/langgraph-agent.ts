/**
 * Task 整合-1 — LangGraph 主线 Agent(替代手写 runAgentStream)
 *
 * 规划:docs/开发规划.md 整合阶段 Task 整合-1
 * 八股:02-核心框架.md §6 LangGraph 状态机 / Q9~Q11 何时选 LangGraph
 *
 * 用 langchain.createAgent(LangChain 1.x 推荐 API)替换原手写的 ReAct 主循环。
 * 工具复用 src/agent/tools.ts 的 runTool 实现(包成 LangChain tool 即可),
 * 事件流由 src/agent/langgraphToAgUi.ts 翻译成项目原生 AG-UI 事件,前端 0 改动。
 *
 * 设计要点:
 * - 工具 wrap 时绑当次 sourceMap(闭包),保留 sources 透传到 RUN_FINISHED 的能力
 * - ChatOpenAI 走 configuration.baseURL 对接 MiniMax 兼容协议(.env 已配)
 * - [ASK_USER] 字符串协议仍在 adapter 层做(不立即升级到 LangGraph 原生 interrupt(),
 *   留给 Task 整合-2 / Task 4.5)
 * - MemorySaver 是进程内 Checkpointer,Task 4.5 完整版升级到 SqliteSaver / MySQLSaver
 */

import { createAgent } from 'langchain'
import { tool } from '@langchain/core/tools'
import { MemorySaver } from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import { runTool } from './tools.js'
import type { AgUiEvent, Source } from './ag-ui.js'
import type { ChatMessage, ResumeItem, TokenUsage } from './llm.js'
import { translateLangGraphStream } from './langgraphToAgUi.js'

// 进程内 Checkpointer 单例;thread_id = sessionId 时,LangGraph 自动管会话状态
// 注:本任务整合-1 我们仍把完整 messages 传入(不依赖 thread 历史),
//     真正启用 thread 持久化在整合-2(会话续流)
const checkpointer = new MemorySaver()

// ─── 工具 wrap:把现有 runTool 包成 LangChain tool ──────────────
function buildTools(pool: DbPool, config: AppConfig, sourceMap: Map<number, Source>) {
  const wrap = <S extends z.ZodTypeAny>(name: string, schema: S, description: string) =>
    tool(
      async (input: z.infer<S>): Promise<string> => {
        const result = await runTool(pool, config, name, JSON.stringify(input))
        // sources 透传:工具调用引用过的目的地,跨多轮去重(保留首次 via)
        if (result.sources) {
          for (const s of result.sources) {
            if (!sourceMap.has(s.destinationId)) sourceMap.set(s.destinationId, s)
          }
        }
        // LangChain tool 只接受 string return(给 LLM 看);sources 通过闭包旁路传出
        return result.text
      },
      { name, description, schema }
    )

  return [
    wrap(
      'search_destinations',
      z.object({
        query: z.string().describe('检索关键词或偏好描述'),
        region: z.string().optional().describe('可选:地区/省份筛选'),
        limit: z.number().int().optional().default(10).describe('返回条数上限')
      }),
      '按关键词或偏好做结构化检索(名称、地区、摘要等 LIKE 匹配)。适合用户能说出较明确词或地区时使用。'
    ),
    wrap(
      'get_destination_detail',
      z.object({
        destination_id: z.number().int().describe('目的地 id')
      }),
      '读取某一目的地的结构化详情,并枚举美食、美景、文化条目。列举事实时必须调用。'
    ),
    wrap(
      'semantic_search_travel',
      z.object({
        query: z.string().describe('自然语言需求描述'),
        topK: z.number().int().optional().default(5).describe('返回 Top-K 条结果'),
        category: z
          .enum(['summary', 'food', 'scenery', 'culture'])
          .optional()
          .describe('可选:仅检索某一类内容')
      }),
      '按自然语言"感觉/偏好/灵感"做向量语义检索(例如「想看雪山又不想太累」)。当用户描述模糊或难以用关键词表达时优先使用此工具。'
    )
  ]
}

function buildChatModel(config: AppConfig): ChatOpenAI {
  return new ChatOpenAI({
    model: config.OPENAI_MODEL,
    apiKey: config.OPENAI_API_KEY,
    // configuration 字段对接 OpenAI 兼容协议(MiniMax 走这里)
    configuration: { baseURL: config.OPENAI_BASE_URL },
    temperature: config.LLM_TEMPERATURE,
    topP: config.LLM_TOP_P,
    maxTokens: config.LLM_MAX_TOKENS,
    streaming: true,
    // Task 1.2:确保流式返回 usage
    streamUsage: true
  })
}

/**
 * LangGraph 版 Agent 入口,跟 runAgentStream 同签名,handler 切换 0 侵入
 */
export async function* runLangGraphAgent(
  pool: DbPool,
  config: AppConfig,
  messages: ChatMessage[],
  threadId: string,
  runId: string,
  _resume?: ResumeItem[],
  options?: {
    signal?: AbortSignal
    onUsage?: (usage: TokenUsage, round: number) => void
  }
): AsyncGenerator<AgUiEvent> {
  const sourceMap = new Map<number, Source>()
  const tools = buildTools(pool, config, sourceMap)
  const model = buildChatModel(config)

  // 把 system 单独抽出来给 createAgent.systemPrompt;其他 messages 作为初始 state
  const systemMsg = messages.find((m) => m.role === 'system')
  const otherMsgs = messages.filter((m) => m.role !== 'system')
  const systemPrompt = systemMsg && typeof systemMsg.content === 'string' ? systemMsg.content : undefined

  const agent = createAgent({
    model,
    tools,
    systemPrompt,
    checkpointer
  })

  // 注:thread_id 用 runId 而非 sessionId — 整合-1 不启用跨请求 thread 复用,
  //     每次新 run 都是干净 thread;整合-2 会改为 sessionId 启用真正的会话持久化
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
    onUsage: options?.onUsage
  })
}

/** 把项目内的 ChatMessage 转成 LangChain 接受的 plain message 对象 */
function toLangChainMessage(m: ChatMessage): { role: string; content: string; tool_call_id?: string } {
  if (m.role === 'user') return { role: 'user', content: m.content }
  if (m.role === 'assistant') return { role: 'assistant', content: m.content ?? '' }
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id }
  return { role: 'system', content: m.content }
}
