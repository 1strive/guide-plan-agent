/**
 * Task 整合-1 + Task 4.4 + Task 4.5 — LangGraph 主线 Agent
 *
 * 规划:docs/开发规划.md 整合阶段 Task 整合-1 + 阶段4 Task 4.4 + Task 4.5
 * 八股:02-核心框架.md §6 LangGraph 状态机 / Q9~Q11 何时选 LangGraph
 *       04-工具调用.md §6 MCP 协议(Task 4.4:工具从 MCP Server 动态发现)
 *       04-工具调用.md §4 Human-in-the-Loop(Task 4.5:原生 interrupt)
 *
 * Task 4.5 改造要点:
 * - 使用 LangGraph 原生 interrupt() 替代旧的 [ASK_USER] 文本协议
 * - askUserTool 内部调用 interrupt()，图真正暂停、checkpoint 持久化
 * - 新增 resumeLangGraphAgent()：通过 Command(resume=answer) 恢复暂停的图
 * - 流结束后通过 agent.getState() 检测是否为 interrupt 暂停
 * - 一次 Run 跨中断：同一 thread_id 从 interrupted → resumed → completed
 */

import { randomUUID } from 'node:crypto'
import { createAgent, createMiddleware } from 'langchain'
import { Command } from '@langchain/langgraph'
import { HumanMessage, isAIMessage, isToolMessage, type BaseMessage } from '@langchain/core/messages'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { ChatOpenAI } from '@langchain/openai'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import type { AgUiEvent, Source } from './ag-ui.js'
import {
  createRunStarted,
  createRunFinished,
  createAskUser,
  createInterrupt,
  type RunFinishedOutcome
} from './ag-ui.js'
import type { ChatMessage, TokenUsage } from './llm.js'
import { translateLangGraphStream, type AdapterLogger } from './langgraphToAgUi.js'
import { askUserTool } from './askUserTool.js'
import { planRouteTool } from './planRouteTool.js'

/**
 * 共享上下文：adapter 填充 usage/sources，caller 在终态事件中使用
 */
export type StreamContext = {
  totalUsage: TokenUsage
  sourceMap: Map<string, Source>
}

// Task 4.5 + PostgreSQL 迁移:PostgresSaver 作为 Checkpointer，复用业务 pg.Pool
// 相比 MemorySaver（进程内存，重启即丢），PostgresSaver 把 checkpoint 持久化到
// PostgreSQL，进程重启 / 重新部署后 interrupt 状态仍可通过 Command(resume) 恢复。
let checkpointer: PostgresSaver | undefined

/**
 * 启动时初始化 Checkpointer（index.ts main() 在 listen 前调用一次）
 * - 复用业务 DbPool，checkpoint 表与业务表同库
 * - setup() 首次运行自动建 checkpoints / checkpoint_writes / checkpoint_blobs 表
 */
export async function initCheckpointer(pool: DbPool): Promise<void> {
  const saver = new PostgresSaver(pool)
  await saver.setup()
  checkpointer = saver
}

/**
 * Task 5.1:加 timeout + maxRetries,底层透传给 OpenAI SDK client。
 * - timeout:LLM_REQUEST_TIMEOUT_MS(默认 60s),超时立刻 reject(不再等 10 分钟)
 * - maxRetries:3 次指数退避(OpenAI SDK 内置退避逻辑,对 timeout / 5xx / 429 自动重试)
 */
export function buildChatModel(config: AppConfig): ChatOpenAI {
  return new ChatOpenAI({
    model: config.OPENAI_MODEL,
    apiKey: config.OPENAI_API_KEY,
    configuration: {
      baseURL: config.OPENAI_BASE_URL,
      timeout: config.LLM_REQUEST_TIMEOUT_MS,
      maxRetries: 3
    },
    temperature: config.LLM_TEMPERATURE,
    topP: config.LLM_TOP_P,
    maxTokens: config.LLM_MAX_TOKENS,
    streaming: true,
    streamUsage: true
  })
}

/**
 * 反 narration 兜底中间件（afterModel）—「只声明不行动」时强制模型补上工具调用
 *
 * 规划:docs/开发规划.md（反问统一走 ask_user 重构 — afterModel 兜底）
 * 八股:04-工具调用.md §4 Human-in-the-Loop（首次实践：确定性保障「该反问就反问、该调工具就调工具」）
 *
 * 背景:弱模型有两种典型「只声明不行动」故障，都会让 ReAct 图误判为最终回答直接 END：
 *   A. 反问 resume 后只回「好的，我来规划路线」而不带 tool_calls → plan_route 从未调用、地图不渲染
 *   B. 首轮就只回「这次我问您几个关键信息…」这类声明，却没真正调用 ask_user → 反问丢失
 * 本中间件在 afterModel 阶段检测这两类情形，注入一条纠偏消息并 jumpTo 'model'，
 * 强制模型要么调用 ask_user 反问、要么直接调用对应工具（如 plan_route）。
 *
 * 触发条件（精确、低误伤）:
 * - 最后一条是 AIMessage 且无 tool_calls、content 非空（纯文本回复）
 * - 且满足下列任一：
 *     A) 倒数第二条是 name==='ask_user' 的 ToolMessage（刚从反问 resume 回来）
 *     B) 文本较短（≤60 字）且命中「未来意图 + 动作动词」的 narration 句式（首轮声明不行动）
 * - 本 run 尚未兜底过（history 里没有 NUDGE_MARKER），最多兜底 1 次防死循环
 */
const ASK_USER_TOOL_NAME = 'ask_user'
const NUDGE_MARKER = '[[force_tool_call_nudge]]'

// 「只声明将要做某事、却没实际调用工具」的 narration 句式：
// 未来/意图标记（让我/我先/这就/接下来/这次/先…）+ 动作动词（问/规划/查/推荐/了解…）。
// 仅在文本较短时启用，避免误伤含实质内容的正常回答。
const NARRATION_INTENT_RE =
  /(让我|我来|我先|我这就|这就|马上|接下来|稍后|这次|先)[^。！!?？]{0,20}(问|询问|了解|确认|查询|查找|搜索|检索|规划|推荐|获取|安排)/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const forceToolCallMiddleware: any = createMiddleware({
  name: 'forceToolCallOnNarration',
  afterModel: {
    hook: (state: { messages: BaseMessage[] }) => {
      const messages = state.messages ?? []
      if (messages.length < 2) return
      const last = messages[messages.length - 1]
      const prev = messages[messages.length - 2]
      if (!last || !prev) return
      // 1. 最后一条 AIMessage 且无 tool_calls、有文本（纯 narration）
      if (!isAIMessage(last)) return
      if ((last.tool_calls?.length ?? 0) > 0) return
      const text = typeof last.content === 'string' ? last.content : ''
      if (!text.trim()) return
      // 2. 命中任一 narration 故障：A) 刚从 ask_user resume 回来；B) 首轮意图句式
      const afterAskUser = isToolMessage(prev) && prev.name === ASK_USER_TOOL_NAME
      const looksLikeIntent = text.trim().length <= 60 && NARRATION_INTENT_RE.test(text)
      if (!afterAskUser && !looksLikeIntent) return
      // 3. 本 run 只兜底一次：history 里已注入过 marker 则放行（防死循环）
      const alreadyNudged = messages.some(
        (m) => typeof m.content === 'string' && m.content.includes(NUDGE_MARKER)
      )
      if (alreadyNudged) return
      // 注入纠偏消息 + 强制再跑一轮模型（jumpTo 'model'）
      return {
        messages: [
          new HumanMessage(
            `你上一句只是声明了将要做的事，却没有实际调用任何工具。请立即行动，二选一：` +
            `若还缺少关键信息（如出发地/目的地/出行方式），调用 ask_user 工具向用户提问；` +
            `若信息已足够，直接调用合适的工具（例如路线场景调用 plan_route）完成请求，不要只用文字说明。${NUDGE_MARKER}`
          )
        ],
        jumpTo: 'model' as const
      }
    },
    canJumpTo: ['model'] as const
  }
})

/**
 * 构建 Agent 实例（run 与 resume 共用相同图结构 + checkpointer）
 * Task 4.5:askUserTool 注入，使 Agent 可调用 interrupt() 暂停图
 */
function buildAgent(
  config: AppConfig,
  tools: StructuredToolInterface[],
  systemPrompt?: string
) {
  const model = buildChatModel(config)
  // Task 4.5:ask_user 工具注入到工具列表末尾
  // 路线改造:plan_route 工具同样注入，作为路线三要素渲染入口（缺项反问统一由 ask_user 负责）
  // 反 narration 兜底:forceToolCallMiddleware 在 afterModel 阶段保障「反问后必调工具」
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAgent({
    model,
    tools: [...tools, askUserTool, planRouteTool] as any,
    systemPrompt,
    checkpointer,
    middleware: [forceToolCallMiddleware]
  } as any)
}

/**
 * Task 4.5:流结束后检测 interrupt 状态
 * 通过 agent.getState() 查询 checkpoint 中是否有 pending interrupt
 */
async function detectInterrupt(
  agent: ReturnType<typeof createAgent>,
  threadId: string
): Promise<{ question: string; options: string[] } | null> {
  try {
    const state = await agent.getState({ configurable: { thread_id: threadId } })
    // LangGraph StateSnapshot.tasks 包含 pending interrupt 信息
    const tasks = (state as { tasks?: Array<{ interrupts?: Array<{ value: unknown }> }> }).tasks
    if (tasks && tasks.length > 0) {
      const firstTask = tasks[0]
      if (firstTask?.interrupts && firstTask.interrupts.length > 0) {
        const payload = firstTask.interrupts[0]?.value as { question?: string; options?: string[] } | undefined
        if (payload && payload.question) {
          return { question: payload.question, options: payload.options ?? [] }
        }
      }
    }
  } catch {
    // getState 失败不阻断主流程
  }
  return null
}

/**
 * Task 4.5:根据 interrupt 检测结果，yield 终态事件
 */
function* emitFinaleEvents(
  interruptPayload: { question: string; options: string[] } | null,
  threadId: string,
  runId: string,
  streamCtx: StreamContext
): Generator<AgUiEvent> {
  if (interruptPayload) {
    // 中断：emit ASK_USER + RUN_FINISHED(interrupt)
    const interruptObj = createInterrupt('input_required', interruptPayload.question, {
      metadata: interruptPayload.options.length > 0 ? { options: interruptPayload.options } : undefined
    })
    const outcome: RunFinishedOutcome = { type: 'interrupt', interrupts: [interruptObj] }
    yield createAskUser(randomUUID(), [{
      id: interruptObj.id,
      message: interruptPayload.question,
      reason: 'input_required',
      options: interruptPayload.options.length > 0 ? interruptPayload.options : undefined
    }])
    yield createRunFinished(threadId, runId, outcome, streamCtx.totalUsage, Array.from(streamCtx.sourceMap.values()))
  } else {
    // 正常完成
    yield createRunFinished(threadId, runId, undefined, streamCtx.totalUsage, Array.from(streamCtx.sourceMap.values()))
  }
}

/**
 * Task 4.4 + 4.5:启动 Agent 执行
 * thread_id = runId，保证同一 Run 的 interrupt/resume 共享 checkpoint
 */
export async function* runLangGraphAgent(
  config: AppConfig,
  tools: StructuredToolInterface[],
  messages: ChatMessage[],
  threadId: string,
  runId: string,
  options?: {
    signal?: AbortSignal
    onUsage?: (usage: TokenUsage, round: number) => void
    log?: AdapterLogger
  }
): AsyncGenerator<AgUiEvent> {
  const systemMsg = messages.find((m) => m.role === 'system')
  const otherMsgs = messages.filter((m) => m.role !== 'system')
  const systemPrompt = systemMsg && typeof systemMsg.content === 'string' ? systemMsg.content : undefined

  const agent = buildAgent(config, tools, systemPrompt)

  const input = { messages: otherMsgs.map(toLangChainMessage) }
  const stream = agent.streamEvents(input, {
    version: 'v2',
    configurable: { thread_id: runId },
    signal: options?.signal
  })

  options?.log?.info(
    { model: config.OPENAI_MODEL, toolCount: tools.length + 2, runId },
    'agent run started'
  )

  // 共享上下文：adapter 填充 usage/sources，caller 在终态事件中使用
  const streamCtx: StreamContext = {
    totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    sourceMap: new Map()
  }

  // RUN_STARTED 由此处统一发射（不再由 adapter 发）
  yield createRunStarted(threadId, runId)

  yield* translateLangGraphStream(stream, {
    threadId,
    runId,
    sourceMap: streamCtx.sourceMap,
    onUsage: options?.onUsage,
    log: options?.log,
    streamCtx
  })

  // Task 4.5:流结束后检测 interrupt
  const interruptPayload = await detectInterrupt(agent, runId)
  yield* emitFinaleEvents(interruptPayload, threadId, runId, streamCtx)
}

/**
 * Task 4.5:恢复暂停的 Agent — Command(resume=answer) 继续同一 Run
 *
 * 使用相同的 thread_id(= runId)从 checkpoint 恢复，
 * ask_user 工具的 interrupt() 调用将返回 answer，Agent 继续推理。
 */
export async function* resumeLangGraphAgent(
  config: AppConfig,
  tools: StructuredToolInterface[],
  threadId: string,
  runId: string,
  answer: string,
  options?: {
    signal?: AbortSignal
    onUsage?: (usage: TokenUsage, round: number) => void
    log?: AdapterLogger
  }
): AsyncGenerator<AgUiEvent> {
  // 构建相同结构的 Agent（共享 checkpointer，从 checkpoint 恢复）
  const agent = buildAgent(config, tools)

  // Task 4.5:Command(resume=answer) 恢复图执行
  const resumeCommand = new Command({ resume: answer })
  const stream = agent.streamEvents(resumeCommand, {
    version: 'v2',
    configurable: { thread_id: runId },
    signal: options?.signal
  })

  options?.log?.info(
    { runId, answerPreview: answer.slice(0, 50) },
    'agent resume started'
  )

  const streamCtx: StreamContext = {
    totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    sourceMap: new Map()
  }

  // Resume 不发 RUN_STARTED（Run 已存在，这是继续阶段）
  yield* translateLangGraphStream(stream, {
    threadId,
    runId,
    sourceMap: streamCtx.sourceMap,
    onUsage: options?.onUsage,
    log: options?.log,
    streamCtx
  })

  // 检测是否再次 interrupt（多轮反问场景）
  const interruptPayload = await detectInterrupt(agent, runId)
  yield* emitFinaleEvents(interruptPayload, threadId, runId, streamCtx)
}

function toLangChainMessage(m: ChatMessage): { role: string; content: string; tool_call_id?: string } {
  if (m.role === 'user') return { role: 'user', content: m.content }
  if (m.role === 'assistant') return { role: 'assistant', content: m.content ?? '' }
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id }
  return { role: 'system', content: m.content }
}
