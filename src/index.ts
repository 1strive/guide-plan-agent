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
import { createSession, insertMessage, listRecentMessages, sessionExists, listSessions, getSessionMessages, updateSessionTitle } from './db/chatRepo.js'
import { SYSTEM_PROMPT } from './agent/prompts.js'
import { runAgentStream, type ChatMessage, type ResumeItem, type TokenUsage } from './agent/llm.js'
import { EventType, type RunFinishedEvent } from './agent/ag-ui.js'

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

  app.get<{ Params: { id: string } }>(
    '/sessions/:id/messages',
    async (req, reply) => {
      const exists = await sessionExists(pool, req.params.id)
      if (!exists) {
        reply.status(404)
        return { error: 'session not found' }
      }
      const messages = await getSessionMessages(pool, req.params.id)
      return { messages }
    }
  )

  app.post('/sessions', async (_req, reply) => {
    const id = randomUUID()
    await createSession(pool, id)
    reply.status(201)
    return { sessionId: id }
  })

  /**
   * POST /sessions/:id/stream — Agent 流式对话入口
   *
   * 规划：Task 1.1 流式输出 + Task 1.2 token 计数 + 阶段5 Task 5.3 可观测
   * 八股：
   * - 08-工程化实践.md §1 容错（超时/abort）/ §2 Token 成本 / §3 全链路可观测（trace_id）
   * - 09-Prompt工程.md §2.4 推理参数
   *
   * 实现要点：
   * - reply.hijack()：交给 raw 流之后绕过 Fastify 默认收尾，由本 handler 全权管理写入与关闭
   * - AbortController：req close → abort，下游 fetch 立即停止；避免客户端断开后空跑烧 token
   * - SSE 心跳：每 15s 发送注释行 `: ping`，防止反向代理在长工具执行时按 idle 超时断连
   * - usage 累加 + 计价：聚合每轮 LLM 的 prompt/completion tokens，按 MODEL_PRICE_*_PER_1K 估算 cost_usd
   * - reqLog：child logger 绑定 runId，串联整次请求所有日志，对应阶段4/5 的 trace_id 需求
   */
  app.post<{ Params: { id: string }; Body: { message?: string; threadId?: string; runId?: string; resume?: ResumeItem[] } }>(
    '/sessions/:id/stream',
    async (req, reply) => {
      const sessionId = req.params.id
      const message = req.body?.message?.trim()
      const threadId = req.body?.threadId ?? sessionId
      const runId = req.body?.runId ?? randomUUID()
      const resume = req.body?.resume as ResumeItem[] | undefined

      if (!message) {
        reply.status(400)
        return { error: 'message required' }
      }
      const exists = await sessionExists(pool, sessionId)
      if (!exists) {
        reply.status(404)
        return { error: 'session not found' }
      }

      // trace_id：把 runId 绑到日志上下文，所有后续日志自动带 runId 字段
      const reqLog = req.log.child({ runId, threadId, sessionId })

      await insertMessage(pool, sessionId, 'user', message)
      const history = await listRecentMessages(pool, sessionId, config.CHAT_HISTORY_LIMIT)

      const msgs: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }]
      for (const h of history) {
        if (h.role === 'user' || h.role === 'assistant') {
          msgs.push({ role: h.role, content: h.content })
        }
      }

      // 接管底层 socket，自行管理 SSE 生命周期
      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Trace-Id': runId
      })

      // ── 客户端断开 → abort 全链路 ───────────────────────────
      const ctl = new AbortController()
      const onClose = () => {
        if (!ctl.signal.aborted) {
          reqLog.info('client closed stream, aborting agent run')
          ctl.abort()
        }
      }
      req.raw.once('close', onClose)

      // ── SSE 心跳：每 15s 发注释行，防止网关 idle 断连 ────────
      const heartbeat = setInterval(() => {
        try { reply.raw.write(': ping\n\n') } catch { /* socket 已关 */ }
      }, 15_000)

      // ── token 用量累加 + 成本估算 ──────────────────────────
      const totalUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      const startedAt = Date.now()
      const onUsage = (u: TokenUsage, round: number) => {
        totalUsage.prompt_tokens += u.prompt_tokens ?? 0
        totalUsage.completion_tokens += u.completion_tokens ?? 0
        totalUsage.total_tokens += u.total_tokens ?? 0
        reqLog.info(
          { round, usage: u, model: config.OPENAI_MODEL },
          'llm round usage'
        )
      }

      let fullContent = ''
      let interruptMessage = ''
      let runError: unknown = null
      try {
        for await (const event of runAgentStream(
          pool, config, msgs, threadId, runId, resume,
          { signal: ctl.signal, onUsage }
        )) {
          if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
            fullContent += (event as { delta: string }).delta
          }
          if (event.type === EventType.RUN_FINISHED) {
            const finished = event as RunFinishedEvent
            if (finished.outcome?.type === 'interrupt') {
              interruptMessage = finished.outcome.interrupts[0]?.message ?? ''
            }
          }
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
        }
      } catch (err) {
        runError = err
        reqLog.error({ err }, 'agent stream failed')
      } finally {
        clearInterval(heartbeat)
        req.raw.off('close', onClose)
      }

      // 仅在客户端未断开时才落库：abort 场景下文本可能不完整，存了反而污染历史
      if (!ctl.signal.aborted) {
        const storedContent = interruptMessage || fullContent
        if (storedContent) {
          await insertMessage(pool, sessionId, 'assistant', storedContent)
        }
        const existing = await getSessionMessages(pool, sessionId)
        if (existing.filter(m => m.role === 'user').length === 1) {
          const title = message.length > 30 ? message.slice(0, 30) + '…' : message
          await updateSessionTitle(pool, sessionId, title)
        }
      }

      // Task 1.2 / 八股 08 §2.5：每次请求结束输出聚合用量与成本
      const costInput = (totalUsage.prompt_tokens / 1000) * config.MODEL_PRICE_INPUT_PER_1K
      const costOutput = (totalUsage.completion_tokens / 1000) * config.MODEL_PRICE_OUTPUT_PER_1K
      reqLog.info(
        {
          model: config.OPENAI_MODEL,
          usage: totalUsage,
          cost_usd: Number((costInput + costOutput).toFixed(6)),
          duration_ms: Date.now() - startedAt,
          aborted: ctl.signal.aborted,
          ok: !runError
        },
        'agent run summary'
      )

      try { reply.raw.end() } catch { /* 已关闭 */ }
    }
  )

  // 八股 08 §5.3：进程退出前优雅关闭，避免连接泄漏与响应中断
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down')
    try {
      await app.close()
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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
