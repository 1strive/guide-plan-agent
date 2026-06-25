import { config } from 'dotenv'
config()
config({ path: '.env.local', override: true })
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import { loadConfig } from './config.js'
import { createPool } from './db/pool.js'
import {
  createSession,
  deleteSession,
  insertMessage,
  listRecentMessages,
  sessionExists,
  listSessions,
  getSessionMessages,
  getSessionStatus,
  updateSessionTitle
} from './db/chatRepo.js'
import { getPrompt } from './agent/prompts/index.js'
import { type ChatMessage } from './agent/llm.js'
import { detectInjection, wrapUntrusted, detectSystemLeak } from './agent/sanitize.js'
import { RunManager } from './agent/runManager.js'
import { McpManager } from './mcp/client.js'
import { getSessionSummary } from './db/chatRepo.js'
import { getRunById, getLastRunBySession, queryArchivedEventsAfter } from './db/runRepo.js'
import { createRedis, closeRedis } from './redis/pool.js'
import type { AgUiEvent } from './agent/ag-ui.js'
import { EventType, type RunFinishedEvent, type TextMessageContentEvent } from './agent/ag-ui.js'

function createLogger() {
  const logsDir = path.resolve('logs')
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }
  const logFile = path.join(logsDir, 'app.log')
  const fileStream = fs.createWriteStream(logFile, { flags: 'a' })
  return pino(
    { level: 'info' },
    pino.multistream([
      { stream: process.stdout },
      { stream: fileStream }
    ])
  )
}

async function main() {
  const config = loadConfig()
  const pool = createPool(config)
  // Task 5.4(Redis 热层改造):启动 Redis 单例,作为事件流热层与 Pub/Sub 广播预留
  const redis = createRedis(config.REDIS_URL)
  const app = Fastify({ loggerInstance: createLogger() })

  await app.register(cors, { origin: true })

  // Task 4.4:MCP 工具管理器 — 启动所有配置的 MCP Server,获取可用工具列表
  const mcpManager = new McpManager(config, app.log)
  if (config.MCP_ENABLED) {
    await mcpManager.init()
    app.log.info({ tools: mcpManager.getToolNames() }, 'MCP servers initialized')
  }

  // Task 整合-2:进程内 Run 注册表;cleanupOnStartup 清理上次残留的 running 状态
  // Task 5.4:注入 redis,RunManager 内部走 Redis Stream 事件流热层
  const runManager = new RunManager(pool, redis, config, app.log, mcpManager, recordRunMetrics)
  await runManager.cleanupOnStartup()


  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1')
      // Task 5.4:并入 Redis PING 探活;任一失败整体 503
      const pong = await redis.ping()
      return { ok: true, db: true, redis: pong === 'PONG' }
    } catch (e) {
      reply.status(503)
      return { ok: false, error: String(e) }
    }
  })

  // Task 5.1:轻量内存 metrics(不引入 Prometheus,够用就行)
  const metrics = {
    totalRuns: 0,
    completedRuns: 0,
    failedRuns: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    recentErrors: [] as Array<{ time: string; runId: string; error: string }>
  }
  // 暴露给 runManager finalize 回调更新(通过闭包)
  function recordRunMetrics(data: { status: string; durationMs: number; tokens: number; runId: string; error?: string }) {
    metrics.totalRuns++
    metrics.totalDurationMs += data.durationMs
    metrics.totalTokens += data.tokens
    if (data.status === 'completed' || data.status === 'interrupted') metrics.completedRuns++
    else {
      metrics.failedRuns++
      metrics.recentErrors.push({ time: new Date().toISOString(), runId: data.runId, error: data.error ?? data.status })
      if (metrics.recentErrors.length > 20) metrics.recentErrors.shift()
    }
  }

  app.get('/metrics', async () => {
    const avgDuration = metrics.totalRuns > 0 ? Math.round(metrics.totalDurationMs / metrics.totalRuns) : 0
    const errorRate = metrics.totalRuns > 0 ? Number((metrics.failedRuns / metrics.totalRuns).toFixed(3)) : 0
    return {
      totalRuns: metrics.totalRuns,
      completedRuns: metrics.completedRuns,
      failedRuns: metrics.failedRuns,
      errorRate,
      avgDurationMs: avgDuration,
      totalTokens: metrics.totalTokens,
      recentErrors: metrics.recentErrors.slice(-5)
    }
  })

  app.get('/sessions', async () => {
    const sessions = await listSessions(pool)
    return { sessions }
  })

  // Task 整合-2:返回 status 字段;running 时前端据此发起续订
  // 新增：若最近 Run 状态为 interrupted，解析 [ASK_USER] 并返回 pendingInterrupt + thinking
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/messages',
    async (req, reply) => {
      const exists = await sessionExists(pool, req.params.id)
      if (!exists) {
        reply.status(404)
        return { error: 'session not found' }
      }
      const messages = await getSessionMessages(pool, req.params.id)
      const status = (await getSessionStatus(pool, req.params.id)) ?? 'end'

      // 检测是否处于 interrupted 状态，若是则解析最后一条 assistant 消息中的 [ASK_USER]
      let pendingInterrupt: {
        questions: Array<{ id: string; message: string; reason: string; options?: string[] }>
      } | null = null

      const lastRun = await getLastRunBySession(pool, req.params.id)
      if (lastRun && lastRun.status === 'interrupted') {
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
        if (lastAssistant) {
          const parsed = parseAskUserContent(lastAssistant.content)
          if (parsed) {
            pendingInterrupt = {
              questions: [{
                id: lastRun.runId,
                message: parsed.question,
                reason: 'input_required',
                options: parsed.options.length > 0 ? parsed.options : undefined,
              }]
            }
          }
        }
      }

      // 从归档事件中提取 thinking 数据，附加到最后一条 assistant 消息
      let lastThinking: string | undefined
      if (lastRun) {
        try {
          const archivedEvents = await queryArchivedEventsAfter(pool, lastRun.runId, 0)
          let thinkingAccum = ''
          for (const row of archivedEvents) {
            const ev = row.eventJson as { type?: string; delta?: string }
            if (ev.type === 'THINKING_CONTENT' && ev.delta) {
              thinkingAccum += ev.delta
            }
          }
          if (thinkingAccum) lastThinking = thinkingAccum
        } catch {
          // 归档查询失败不阻断主流程
        }
      }

      // 构建带 thinking 的响应消息
      const enrichedMessages = messages.map((m, i) => {
        if (lastThinking && m.role === 'assistant' && i === messages.length - 1) {
          return { role: m.role, content: m.content, thinking: lastThinking }
        }
        return { role: m.role, content: m.content }
      })

      return { messages: enrichedMessages, status, pendingInterrupt }
    }
  )

  app.post('/sessions', async (_req, reply) => {
    const id = randomUUID()
    await createSession(pool, id)
    reply.status(201)
    return { sessionId: id }
  })

  /**
   * 八股:05-记忆系统.md §3.2.2 CRUD「删」
   * - 用户可控的会话级硬删除;messages / agent_runs / archived_run_events 由 FK CASCADE 级联清理
   * - 整合-2:若会话有活跃 Run 应先 cancel(避免内存里 RunHandle 引用已删 session)
   */
  app.delete<{ Params: { id: string } }>(
    '/sessions/:id',
    async (req, reply) => {
      const exists = await sessionExists(pool, req.params.id)
      if (!exists) {
        reply.status(404)
        return { error: 'session not found' }
      }
      // 整合-2:若有活跃 Run,先 cancel
      const active = await runManager.getActiveBySession(req.params.id)
      if (active) await runManager.cancel(active.runId)
      await deleteSession(pool, req.params.id)
      reply.status(204)
      return null
    }
  )

  /**
   * 批量删除会话
   * - 遍历 ids,逐个 cancel 活跃 Run 后硬删除
   * - 跳过不存在的 id(幂等)
   */
  app.delete<{ Body: { ids: string[] } }>(
    '/sessions/batch',
    async (req, reply) => {
      const { ids } = req.body || {}
      if (!Array.isArray(ids) || ids.length === 0) {
        reply.status(400)
        return { error: 'ids required (non-empty array)' }
      }
      let deleted = 0
      for (const id of ids) {
        const exists = await sessionExists(pool, id)
        if (!exists) continue
        const active = await runManager.getActiveBySession(id)
        if (active) await runManager.cancel(active.runId)
        await deleteSession(pool, id)
        deleted++
      }
      reply.status(200)
      return { deleted }
    }
  )

  // ── Task 整合-2:Run-as-Resource 新路由 ──────────────────────────────

  /**
   * GET /sessions/:id/runs/active
   * 前端打开会话时调用;返回最近未完成的 Run 元数据(供续订)
   */
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/runs/active',
    async (req, reply) => {
      const exists = await sessionExists(pool, req.params.id)
      if (!exists) {
        reply.status(404)
        return { error: 'session not found' }
      }
      const active = await runManager.getActiveBySession(req.params.id)
      return { active }
    }
  )

  /**
   * POST /sessions/:id/runs/:runId/cancel
   * 用户主动停止 Run;202 Accepted + 幂等
   */
  app.post<{ Params: { id: string; runId: string } }>(
    '/sessions/:id/runs/:runId/cancel',
    async (req, reply) => {
      const run = await getRunById(pool, req.params.runId)
      if (!run || run.sessionId !== req.params.id) {
        reply.status(404)
        return { error: 'run not found' }
      }
      const cancelled = await runManager.cancel(req.params.runId)
      reply.status(202)
      return { cancelled }
    }
  )

  /**
   * GET /sessions/:id/runs/:runId/stream?after_seq=N
   * 续订接口:先回放 seq > N 的历史事件,再接实时流(若 Run 仍活跃)
   * 若 Run 已结束,只回放历史并立即关流
   */
  app.get<{
    Params: { id: string; runId: string }
    Querystring: { after_seq?: string }
  }>('/sessions/:id/runs/:runId/stream', async (req, reply) => {
    const run = await getRunById(pool, req.params.runId)
    if (!run || run.sessionId !== req.params.id) {
      reply.status(404)
      return { error: 'run not found' }
    }
    const afterSeq = Number(req.query.after_seq ?? 0) || 0

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Trace-Id': req.params.runId
    })
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n')
      } catch {
        /* socket 已关 */
      }
    }, 15_000)

    const unsubscribe = await runManager.subscribe(
      req.params.runId,
      (event) => writeSseEvent(reply, event),
      () => {
        clearInterval(heartbeat)
        try {
          reply.raw.end()
        } catch {
          /* ignore */
        }
      },
      afterSeq
    )

    req.raw.once('close', () => {
      unsubscribe()
      clearInterval(heartbeat)
      req.log.info(
        { runId: req.params.runId },
        'resume subscriber disconnected (run continues if active)'
      )
    })
  })

  /**
   * POST /sessions/:id/stream — Agent 流式对话入口(整合-2 重构版)
   *
   * 跟旧版本的核心差异:
   * - 不再 yield agent stream + 自己管 abort + 自己落库
   * - 改为:启动 runManager.start → subscribe → 把事件 SSE 转发给当前请求
   * - 客户端断开 = unsubscribe(不 abort Run),Run 在 runManager 内继续跑、持续写库
   * - assistant 消息落库 / token 累加 / Run 状态机推进全由 runManager 内部处理
   *
   * 规划:整合阶段 Task 整合-2(完整版,吸收原 Task 4.5)
   * 八股:08-工程化实践.md §1 容错 / §3 全链路可观测;02-核心框架.md Run-as-Resource
   */
  app.post<{
    Params: { id: string }
    Body: { message?: string; promptVersion?: string }
  }>('/sessions/:id/stream', async (req, reply) => {
    const sessionId = req.params.id
    const message = req.body?.message?.trim()
    const promptVersion = req.body?.promptVersion ?? config.PROMPT_VERSION

    if (!message) {
      reply.status(400)
      return { error: 'message required' }
    }
    if (!(await sessionExists(pool, sessionId))) {
      reply.status(404)
      return { error: 'session not found' }
    }

    const reqLog = req.log.child({ sessionId })

    // 八股 09 §8.3 #1 输入清洗:入口检测 Prompt 注入(策略见 agent-架构.md §5.6)
    const injection = detectInjection(message)
    if (injection.matched) {
      reqLog.warn(
        {
          patterns: injection.patterns,
          severity: injection.severity,
          messagePreview: message.slice(0, 80)
        },
        'prompt injection detected'
      )
    }

    // 持久化 user 消息(原始),首条自动生成 title
    await insertMessage(pool, sessionId, 'user', message)
    const history = await listRecentMessages(pool, sessionId, config.CHAT_HISTORY_LIMIT) //取对应会话的前CHAT_HISTORY_LIMIT条历史数据
    if (history.filter((h) => h.role === 'user').length === 1) {
      const title = message.length > 30 ? message.slice(0, 30) + '…' : message
      updateSessionTitle(pool, sessionId, title).catch((err) =>
        reqLog.error({ err }, 'updateSessionTitle failed')
      )
    }

    // Task 4.3:注入记忆摘要
    const sessionSummary = await getSessionSummary(pool, sessionId)
    const prompt = getPrompt(promptVersion, {
      memory_summary: sessionSummary ?? ''
    })
    reqLog.info({ promptVersion, prompt, sessionSummary }, 'using prompt version')
    const msgs: ChatMessage[] = [{ role: 'system', content: prompt.system }]
    for (const m of prompt.prependMessages) {
      msgs.push(
        m.role === 'user'
          ? { role: 'user', content: m.content }
          : { role: 'assistant', content: m.content }
      )
    }
    for (const h of history) {
      if (h.role === 'user' || h.role === 'assistant') {
        msgs.push({ role: h.role, content: h.content })
      }
    }
    // 八股 09 §8.3 #2 边界标记:命中注入时把当前 user 消息用 <untrusted_user_content> 包裹
    if (injection.matched) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m && m.role === 'user' && m.content === message) {
          msgs[i] = { role: 'user', content: wrapUntrusted(message) }
          break
        }
      }
    }

    // Task 整合-2:启动 Run via runManager(不阻塞);拿到 runId 立刻可订阅
    // Task 4.1.B:给 runManager 传 reqLog,内部 child({ runId }) 后所有 log 自动带 runId
    const runId = await runManager.start(sessionId, msgs, reqLog)
    reqLog.info({ runId }, 'run started')

    // SSE 接管
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Trace-Id': runId
    })
    // 心跳防网关 idle 断连
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n')
      } catch {
        /* socket 已关 */
      }
    }, 15_000)

    // 收集 finalText 给出口注入检测用(SSE 转发同时旁路聚合)
    let fullContent = ''
    let interruptMessage = ''
    const onEvent = (event: AgUiEvent): void => {
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
        fullContent += (event as TextMessageContentEvent).delta
      } else if (event.type === EventType.RUN_FINISHED) {
        const fin = event as RunFinishedEvent
        if (fin.outcome?.type === 'interrupt') {
          interruptMessage = fin.outcome.interrupts[0]?.message ?? ''
        }
      }
      writeSseEvent(reply, event)
    }

    const onEnd = (): void => {
      clearInterval(heartbeat)
      // 出口注入检测(八股 09 §8.3 #5):命中只告警,不修改输出
      const finalText = interruptMessage || fullContent
      if (finalText) {
        const leak = detectSystemLeak(finalText, prompt.system)
        if (leak.matched) {
          reqLog.warn(
            {
              runId,
              leakedFragments: leak.leakedFragments,
              outputPreview: finalText.slice(0, 120)
            },
            'system prompt leak detected in output'
          )
        }
      }
      try {
        reply.raw.end()
      } catch {
        /* ignore */
      }
    }

    const unsubscribe = await runManager.subscribe(runId, onEvent, onEnd, 0)

    // 整合-2 核心:客户端断开 = 只 unsubscribe,Run 在后台继续跑、持续写库
    req.raw.once('close', () => {
      unsubscribe()
      clearInterval(heartbeat)
      reqLog.info(
        { runId },
        'client unsubscribed (run continues in background, persistence ongoing)'
      )
    })
  })

  // 八股 08 §5.3:进程退出前优雅关闭
  // Task 5.4:Redis 在 pool.end 之前 quit,避免归档收尾时连接已关
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down')
    try {
      await app.close()
      await mcpManager.shutdown()
      await closeRedis()
      await pool.end()
    } catch (err) {
      app.log.error({ err }, 'shutdown error')
    } finally {
      process.exit(0)
    }
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))

  await app.listen({ port: config.PORT, host: '0.0.0.0' })
}

// SSE 单事件写入 helper;吞 socket 已关异常
function writeSseEvent(reply: import('fastify').FastifyReply, event: unknown): void {
  try {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
  } catch {
    /* socket closed */
  }
}

/**
 * 解析 assistant content 中的 [ASK_USER] 格式
 * 格式: "\n\n[ASK_USER]\n问题内容\n【选项】\n1. 选项A\n2. 选项B\n..."
 * 返回 { question, options } 或 null（不含 [ASK_USER] 前缀）
 */
function parseAskUserContent(content: string): { question: string; options: string[] } | null {
  const marker = '[ASK_USER]'
  const idx = content.indexOf(marker)
  if (idx === -1) return null

  const afterMarker = content.slice(idx + marker.length).trim()
  const optionMarker = '【选项】'
  const optIdx = afterMarker.indexOf(optionMarker)

  if (optIdx === -1) {
    return { question: afterMarker, options: [] }
  }

  const question = afterMarker.slice(0, optIdx).trim()
  const optionsBlock = afterMarker.slice(optIdx + optionMarker.length).trim()
  const options = optionsBlock
    .split('\n')
    .map(line => line.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean)

  return { question, options }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
