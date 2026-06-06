/**
 * Task 整合-2 — RunManager:进程内 Run 注册表 + 事件总线 + 订阅者
 *
 * 规划:docs/开发规划.md 整合阶段 Task 整合-2 §B 主动取消 + §D 多订阅者 + §E 重启降级
 * 八股:08-工程化实践.md §1 容错(细粒度 abort 是熔断之外的另一种"防止失控")
 *
 * 设计要点:
 * - **三态 abort 模型**:per-subscriber Controller(handler 持有,仅 unsubscribe)和
 *   per-run Controller(本 RunManager 持有,仅在 cancel / SIGTERM / 超时触发),
 *   两个 Controller **互不级联** —— 客户端断开 ≠ Run 终止
 * - **seq 单调递增**:内存 counter(同一 Run 串行 yield 事件,无并发问题);
 *   每个事件:appendEvent 写库 + 广播给所有 subscriber + 处理 assistant 消息持久化
 * - **subscriber 不阻塞 pump**:onEvent 异常 catch 吞掉,避免单订阅者拖垮整个 Run
 * - **状态机推进**:pending → running → {completed | interrupted | cancelling → cancelled | failed}
 * - **Checkpointer 不升级**:继续 MemorySaver,LangGraph 内部 thread 状态进程内活;
 *   "进程重启真正续跑"留给 Task 5.4(配合 Redis Pub/Sub 跨进程)
 */

import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import type { AgUiEvent } from './ag-ui.js'
import { EventType, type RunFinishedEvent, type TextMessageContentEvent } from './ag-ui.js'
import type { ChatMessage, TokenUsage } from './llm.js'
import { runLangGraphAgent } from './langgraph-agent.js'
import { maybeUpdateMemory } from './memory.js'
// Task 4.4:MCP 工具管理器
import type { McpManager } from '../mcp/client.js'
import {
  appendEvent as repoAppendEvent,
  createRun,
  getActiveRunBySession,
  getRunById,
  incrementRunTokens,
  markAllRunningAsFailed,
  queryEventsAfter,
  updateRunStatus,
  type AgentRunRow,
  type AgentRunStatus
} from '../db/runRepo.js'
import {
  insertAssistantStub,
  markAllSessionsAsEnd,
  updateAssistantContent,
  updateSessionStatus
} from '../db/chatRepo.js'
import { computeCostUsd } from './token-usage.js'

export type Subscriber = {
  id: string
  onEvent: (event: AgUiEvent) => void
  onEnd: () => void
}

type RunHandle = {
  runId: string
  sessionId: string
  status: AgentRunStatus
  seqCounter: number
  subscribers: Map<string, Subscriber>
  abortController: AbortController
  // 流式 assistant 消息:进入时 INSERT stub,每个 TEXT_MESSAGE_END update 一次
  currentAssistantMessageId: number | null
  currentAssistantContent: string
  // 累计 usage,RUN_FINISHED 时一次性 update 到 agent_runs.total_tokens
  totalTokensDelta: number
  // Task 4.1.B:trace-id 透传;child logger 已绑 runId,所有 info/warn/error 行自动出现 runId
  log: FastifyBaseLogger
  // Task 4.1.B:run summary 数据(finalize 时一次性 info,做"一次 Run 的 trace 索引")
  startedAt: number
  toolStats: { count: number; names: string[] }
  // Task 4.1.C:累计 promptTokens / completionTokens,用于 cost 计算
  promptTokensDelta: number
  completionTokensDelta: number
  // Task 4.3:保存 messages 给 finalize 时的记忆摘要用
  messages: ChatMessage[]
}

const ACTIVE_STATUSES: AgentRunStatus[] = ['pending', 'running', 'cancelling']

export class RunManager {
  private runs = new Map<string, RunHandle>()

  constructor(
    private pool: DbPool,
    private config: AppConfig,
    private log: FastifyBaseLogger,
    // Task 4.4:MCP 工具管理器,getTools() 返回 LangChain StructuredTool[]
    private mcpManager: McpManager
  ) {}

  /**
   * 启动时清理上次进程残留(failed)+ 同步 chat_sessions.status
   * main() 在 listen 前调用一次
   */
  async cleanupOnStartup(): Promise<void> {
    const runsCleaned = await markAllRunningAsFailed(this.pool)
    const sessionsCleaned = await markAllSessionsAsEnd(this.pool)
    if (runsCleaned > 0 || sessionsCleaned > 0) {
      this.log.warn(
        { runsCleaned, sessionsCleaned },
        'startup cleanup: marked stale running runs as failed'
      )
    }
  }

  /**
   * 创建 Run + 启动 LangGraph + 后台 pump 事件(fire-and-forget)
   * 返回 runId,handler 立刻可以 subscribe
   */
  async start(
    sessionId: string,
    messages: ChatMessage[],
    parentLog?: FastifyBaseLogger
  ): Promise<string> {
    const runId = randomUUID()
    // Task 4.1.B:child logger 自动绑 runId,后续所有 handle.log.info 都带 { runId }
    const log: FastifyBaseLogger = (parentLog ?? this.log).child({ runId })
    const handle: RunHandle = {
      runId,
      sessionId,
      status: 'pending',
      seqCounter: 0,
      subscribers: new Map(),
      abortController: new AbortController(),
      currentAssistantMessageId: null,
      currentAssistantContent: '',
      totalTokensDelta: 0,
      log,
      startedAt: Date.now(),
      toolStats: { count: 0, names: [] },
      promptTokensDelta: 0,
      completionTokensDelta: 0,
      messages
    }
    this.runs.set(runId, handle)

    await createRun(this.pool, runId, sessionId, 'pending')
    await updateSessionStatus(this.pool, sessionId, 'running')
    await updateRunStatus(this.pool, runId, 'running')
    handle.status = 'running'

    const agentOptions = {
      signal: handle.abortController.signal,
      onUsage: (u: TokenUsage) => {
        handle.totalTokensDelta += u.totalTokens
        handle.promptTokensDelta += u.promptTokens
        handle.completionTokensDelta += u.completionTokens
      },
      // Task 4.1.B:把 child logger 透到 adapter,工具调用 timing 日志自动带 runId
      log: handle.log
    }

    // Task 4.4:MCP 工具列表由 McpManager 提供,运行时动态发现
    const tools = this.mcpManager.getTools()
    const generator = runLangGraphAgent(
            this.config,
            tools,
            messages,
            sessionId,
            runId,
            undefined,
            agentOptions
          )

    // fire-and-forget;pump 内部 catch 异常
    this.pumpRun(handle, generator).catch((err) => {
      handle.log.error({ err: String(err) }, 'runManager pump crashed')
    })

    return runId
  }

  /**
   * 新订阅者接入:回放历史事件 + 加入实时广播
   * @param afterSeq 续订起点(0 = 从头);打开会话时前端传已知 lastEventSeq
   * @returns unsubscribe 函数
   */
  async subscribe(
    runId: string,
    onEvent: (event: AgUiEvent) => void,
    onEnd: () => void,
    afterSeq: number = 0
  ): Promise<() => void> {
    const subscriberId = randomUUID()

    // 1. 先回放历史(可能 Run 已结束,只回放即可)
    const historicalEvents = await queryEventsAfter(this.pool, runId, afterSeq)
    for (const row of historicalEvents) {
      try {
        onEvent(row.eventJson as AgUiEvent)
      } catch (err) {
        this.log.error({ runId, err: String(err) }, 'subscribe replay onEvent crashed')
      }
    }

    // 2. Run 还活着 → 加入实时广播
    const handle = this.runs.get(runId)
    if (handle && this.isActive(handle.status)) {
      const sub: Subscriber = { id: subscriberId, onEvent, onEnd }
      handle.subscribers.set(subscriberId, sub)
      return () => {
        handle.subscribers.delete(subscriberId)
      }
    }

    // 3. Run 已结束 → 立刻调 onEnd(回放已完成),无需实时
    queueMicrotask(() => {
      try {
        onEnd()
      } catch {
        /* ignore */
      }
    })
    return () => {
      /* no-op,已不在 subscribers 里 */
    }
  }

  /**
   * 主动取消:触发 per-run abort,状态推进 cancelling → cancelled
   * 幂等:已 cancelled / completed 等终态调用是 no-op
   */
  async cancel(runId: string): Promise<boolean> {
    const handle = this.runs.get(runId)
    if (!handle) {
      // 内存中已无,可能 Run 已结束;DB 看一眼是否还活着
      const row = await getRunById(this.pool, runId)
      if (row && this.isActive(row.status)) {
        // 这种情况通常不应发生(内存外的活跃 Run 是数据不一致),直接标 failed
        await updateRunStatus(this.pool, runId, 'failed', true)
        return true
      }
      return false
    }
    if (!this.isActive(handle.status)) return false
    handle.status = 'cancelling'
    await updateRunStatus(this.pool, runId, 'cancelling')
    handle.abortController.abort()
    return true
  }

  /** GET /sessions/:id/runs/active 用 */
  async getActiveBySession(sessionId: string): Promise<AgentRunRow | null> {
    return getActiveRunBySession(this.pool, sessionId)
  }

  /** 用于 handler 判断"该 Run 还活着"决定是否要接实时流 */
  isRunActive(runId: string): boolean {
    const h = this.runs.get(runId)
    return !!h && this.isActive(h.status)
  }

  // ─── 内部:事件 pump ───────────────────────────────────────────

  private async pumpRun(handle: RunHandle, generator: AsyncIterable<AgUiEvent>): Promise<void> {
    let finalStatus: AgentRunStatus = 'completed'
    let interruptCaught = false
    try {
      for await (const event of generator) {
        await this.handleEvent(handle, event)
        if (event.type === EventType.RUN_FINISHED) {
          const finished = event as RunFinishedEvent
          if (finished.outcome?.type === 'interrupt') interruptCaught = true
        }
      }
      if (interruptCaught) finalStatus = 'interrupted'
    } catch (err) {
      // 如果是 cancelling 中收到 abort 错误 → cancelled;否则 failed
      finalStatus = handle.status === 'cancelling' ? 'cancelled' : 'failed'
      handle.log.warn(
        { err: String(err), finalStatus },
        'runManager pump caught error'
      )
    } finally {
      await this.finalize(handle, finalStatus)
    }
  }

  private async handleEvent(handle: RunHandle, event: AgUiEvent): Promise<void> {
    const seq = ++handle.seqCounter

    // 1. 写事件流(顺序保证)
    try {
      await repoAppendEvent(this.pool, handle.runId, seq, event)
    } catch (err) {
      handle.log.error({ seq, err: String(err) }, 'appendEvent failed')
    }

    // 2. 处理 assistant 消息的增量持久化
    await this.persistAssistantMessage(handle, event)

    // Task 4.1.B:累加 toolStats(给 finalize 的 run summary 用)
    if (event.type === EventType.TOOL_CALL_START) {
      const ev = event as { toolCallName?: string }
      handle.toolStats.count += 1
      if (ev.toolCallName) handle.toolStats.names.push(ev.toolCallName)
    }

    // 3. 广播给所有 subscriber(吞异常,避免单订阅者拖垮 pump)
    for (const sub of handle.subscribers.values()) {
      try {
        sub.onEvent(event)
      } catch (err) {
        handle.log.warn({ err: String(err) }, 'subscriber.onEvent threw')
      }
    }
  }

  /**
   * assistant 消息持久化策略:
   * - 首次 TEXT_MESSAGE_CONTENT 时 INSERT stub(content='')
   * - 每次 TEXT_MESSAGE_CONTENT 累加到内存 content
   * - TEXT_MESSAGE_END 时 UPDATE 整条 content(避免每 token 一次 IO)
   *   若 Run 没正常结束,END 不会触发 — 但 stub 已有,续订时 content 会是""
   *   (可接受,Task 4.x 再优化为定时 flush)
   */
  private async persistAssistantMessage(handle: RunHandle, event: AgUiEvent): Promise<void> {
    if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
      const ev = event as TextMessageContentEvent
      if (handle.currentAssistantMessageId === null) {
        handle.currentAssistantMessageId = await insertAssistantStub(this.pool, handle.sessionId)
        handle.currentAssistantContent = ''
      }
      handle.currentAssistantContent += ev.delta
    } else if (event.type === EventType.TEXT_MESSAGE_END) {
      if (handle.currentAssistantMessageId !== null && handle.currentAssistantContent.length > 0) {
        await updateAssistantContent(
          this.pool,
          handle.currentAssistantMessageId,
          handle.currentAssistantContent
        )
      }
      // 准备接下一条 assistant 消息(同 Run 多轮 ReAct 可能多条)
      handle.currentAssistantMessageId = null
      handle.currentAssistantContent = ''
    }
  }

  private async finalize(handle: RunHandle, status: AgentRunStatus): Promise<void> {
    handle.status = status
    // 若有遗留 assistant content 没 flush(中断场景),强制 flush
    if (handle.currentAssistantMessageId !== null && handle.currentAssistantContent.length > 0) {
      try {
        await updateAssistantContent(
          this.pool,
          handle.currentAssistantMessageId,
          handle.currentAssistantContent
        )
      } catch (err) {
        handle.log.error({ err: String(err) }, 'finalize: flush assistant failed')
      }
    }

    try {
      await updateRunStatus(this.pool, handle.runId, status, true)
      await updateSessionStatus(this.pool, handle.sessionId, 'end')
      if (handle.totalTokensDelta > 0) {
        await incrementRunTokens(this.pool, handle.runId, handle.totalTokensDelta)
      }
    } catch (err) {
      handle.log.error({ err: String(err) }, 'finalize: DB update failed')
    }

    // 通知所有订阅者 Run 已结束
    for (const sub of handle.subscribers.values()) {
      try {
        sub.onEnd()
      } catch {
        /* ignore */
      }
    }
    handle.subscribers.clear()
    this.runs.delete(handle.runId)

    // Task 4.1.C:run summary — 一行结构化日志,作为"一次 Run 的 trace 索引"
    //   字段:status / durationMs / totalTokens / costUsd / toolStats
    //   child logger 已绑 runId,grep runId=xxx 即可拿全链路(run started → tool finished × N → run summary)
    const durationMs = Date.now() - handle.startedAt
    const costUsd = computeCostUsd(
      {
        promptTokens: handle.promptTokensDelta,
        completionTokens: handle.completionTokensDelta,
        totalTokens: handle.totalTokensDelta
      },
      this.config
    )
    handle.log.info(
      {
        status,
        durationMs,
        totalTokens: handle.totalTokensDelta,
        promptTokens: handle.promptTokensDelta,
        completionTokens: handle.completionTokensDelta,
        costUsd: Number(costUsd.toFixed(6)),
        toolStats: handle.toolStats
      },
      'run summary'
    )

    // Task 4.3:记忆分层 — Run 正常完成后异步生成对话摘要(fire-and-forget)
    if (status === 'completed' || status === 'interrupted') {
      maybeUpdateMemory(this.pool, this.config, handle.sessionId, handle.messages, handle.log)
        .catch((err) => handle.log.error({ err: String(err) }, 'memory update failed'))
    }
  }

  private isActive(status: AgentRunStatus): boolean {
    return ACTIVE_STATUSES.includes(status)
  }
}
