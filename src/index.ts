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
import { getAllSkills, buildSkillsPromptSection } from './skills/loader.js'
import { getSessionSummary } from './db/chatRepo.js'
import { getRunById, queryEventsAfter } from './db/runRepo.js'
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
  const app = Fastify({ loggerInstance: createLogger() })

  await app.register(cors, { origin: true })

  // Task 4.4:MCP 工具管理器 — 启动所有配置的 MCP Server,获取可用工具列表
  const mcpManager = new McpManager(config)
  if (config.MCP_ENABLED) {
    await mcpManager.init()
    app.log.info({ tools: mcpManager.getToolNames() }, 'MCP servers initialized')
  }

  // Task 整合-2:进程内 Run 注册表;cleanupOnStartup 清理上次残留的 running 状态
  const runManager = new RunManager(pool, config, app.log, mcpManager)
  await runManager.cleanupOnStartup()

  // Task 4.4:Skills — 启动时加载,生成 prompt 段落
  const skills = getAllSkills()
  const skillsPrompt = buildSkillsPromptSection(skills, mcpManager.getToolNames())

  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1')
      return { ok: true, db: true }
    } catch (e) {
      reply.status(503)
      return { ok: false, db: false, error: String(e) }
    }
  })

  app.get('/sessions', async () => {
    const sessions = await listSessions(pool)
    return { sessions }
  })

  // Task 整合-2:返回 status 字段;running 时前端据此发起续订
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
      return { messages, status }
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
   * - 用户可控的会话级硬删除;messages / agent_runs / agent_run_events 由 FK CASCADE 级联清理
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
    const history = await listRecentMessages(pool, sessionId, config.CHAT_HISTORY_LIMIT)
    if (history.filter((h) => h.role === 'user').length === 1) {
      const title = message.length > 30 ? message.slice(0, 30) + '…' : message
      updateSessionTitle(pool, sessionId, title).catch((err) =>
        reqLog.error({ err }, 'updateSessionTitle failed')
      )
    }

    // Task 4.3:注入记忆摘要;Task 4.4:注入 Skills 上下文
    const sessionSummary = await getSessionSummary(pool, sessionId)
    const prompt = getPrompt(promptVersion, {
      memory_summary: sessionSummary ?? '',
      skills_context: skillsPrompt
    })
    reqLog.info({ promptVersion }, 'using prompt version')
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
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down')
    try {
      await app.close()
      await mcpManager.shutdown()
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

// 未使用但保留导出供未来扩展:精细查询事件回放(测试用)
void queryEventsAfter

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
