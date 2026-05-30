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
import { createSession, deleteSession, insertMessage, listRecentMessages, sessionExists, listSessions, getSessionMessages, updateSessionTitle, updateSessionTokens } from './db/chatRepo.js'
import { getPrompt } from './agent/prompts/index.js'
import { runAgentStream, type ChatMessage, type ResumeItem, type TokenUsage } from './agent/llm.js'
import { EventType, type RunFinishedEvent } from './agent/ag-ui.js'
import { detectInjection, wrapUntrusted, detectSystemLeak } from './agent/sanitize.js'

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
   * 八股:05-记忆系统.md §3.2.2 CRUD「删」
   * - 用户可控的会话级硬删除;messages 由 FK CASCADE 级联清理
   * - 当前阶段1 Chat App 心智:前端在删除当前激活会话前会自己 abort 正在跑的 SSE
   *   (web/src/App.tsx handleDeleteSession),客户端连接关闭即触发上面 stream 路由
   *   的 req.raw 'close' 钩子,把 agent run 也停掉 —— 故本路由无需额外终止 in-flight stream。
   * - Task 4.5 重构为 Run-as-Resource 后,这里需要联动 runManager.cancel(runId)
   */
  app.delete<{ Params: { id: string } }>(
    '/sessions/:id',
    async (req, reply) => {
      const exists = await sessionExists(pool, req.params.id)
      if (!exists) {
        reply.status(404)
        return { error: 'session not found' }
      }
      await deleteSession(pool, req.params.id)
      reply.status(204)
      return null
    }
  )

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
   * - updateSessionTokens：把累计 token 持久化到 chat_sessions，便于按会话维度做成本审计
   */
  app.post<{ Params: { id: string }; Body: { message?: string; threadId?: string; runId?: string; resume?: ResumeItem[]; promptVersion?: string } }>(
    '/sessions/:id/stream',
    async (req, reply) => {
      const sessionId = req.params.id
      const message = req.body?.message?.trim()
      const threadId = req.body?.threadId ?? sessionId
      const runId = req.body?.runId ?? randomUUID()
      const resume = req.body?.resume as ResumeItem[] | undefined
      // Task 2.2:请求级 promptVersion 可覆盖全局 config,便于评测脚本按 case 切版本;
      // 不传时回落到 config.PROMPT_VERSION,保证生产请求有默认值兜底
      const promptVersion = req.body?.promptVersion ?? config.PROMPT_VERSION

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

      // 八股 09 §8.3 #1 输入清洗:入口检测 Prompt 注入。
      // 策略(见 docs/04-架构文档/agent-架构.md §5.6):命中不拒绝请求,
      // 仅记录日志 + 把消息用 <untrusted_user_content> 包裹,让模型自己按 securityRules 拒绝
      const injection = detectInjection(message)
      if (injection.matched) {
        reqLog.warn(
          { patterns: injection.patterns, severity: injection.severity, messagePreview: message.slice(0, 80) },
          'prompt injection detected'
        )
      }

      // DB 存原始消息(审计/历史回放需要看真实输入)
      await insertMessage(pool, sessionId, 'user', message)
      const history = await listRecentMessages(pool, sessionId, config.CHAT_HISTORY_LIMIT)

      // Task 2.1:从注册表取当前版本的 system + Few-shot prepend;
      // Task 4.3 后这里会传入 { summary, userProfile } 之类的插值变量
      const prompt = getPrompt(promptVersion)
      reqLog.info({ promptVersion }, 'using prompt version')
      const msgs: ChatMessage[] = [{ role: 'system', content: prompt.system }]
      // Task 2.2 / 八股 09 §3.5:Few-shot 示例以 user/assistant 对话形式注入,排在历史之前
      for (const m of prompt.prependMessages) {
        if (m.role === 'user') {
          msgs.push({ role: 'user', content: m.content })
        } else {
          msgs.push({ role: 'assistant', content: m.content })
        }
      }
      for (const h of history) {
        if (h.role === 'user' || h.role === 'assistant') {
          msgs.push({ role: h.role, content: h.content })
        }
      }

      // 八股 09 §8.3 #2 边界标记:命中注入时,把"当前 user 消息"在喂给 LLM 前包裹
      // (DB 里仍是原始消息;不包裹历史里的旧消息——旧攻击假定已经被防御过)
      if (injection.matched) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]
          if (m && m.role === 'user' && m.content === message) {
            msgs[i] = { role: 'user', content: wrapUntrusted(message) }
            break
          }
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
      const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      const startedAt = Date.now()
      const onUsage = (u: TokenUsage, round: number) => {
        totalUsage.promptTokens += u.promptTokens
        totalUsage.completionTokens += u.completionTokens
        totalUsage.totalTokens += u.totalTokens
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

      // 八股 09 §8.3 #5 输出过滤:检测最终回答是否泄露 system prompt 特征句。
      // 命中只告警不修改输出——避免过度干预正常回答(prompt 防御指令本身就要求模型拒绝)
      const finalText = interruptMessage || fullContent
      if (finalText) {
        const leak = detectSystemLeak(finalText, prompt.system)
        if (leak.matched) {
          reqLog.warn(
            { leakedFragments: leak.leakedFragments, outputPreview: finalText.slice(0, 120) },
            'system prompt leak detected in output'
          )
        }
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
        // Task 1.2：把本次累计 token 写回 chat_sessions，便于按会话审计成本
        if (totalUsage.totalTokens > 0) {
          try {
            await updateSessionTokens(pool, sessionId, totalUsage.totalTokens)
          } catch (err) {
            reqLog.error({ err }, 'updateSessionTokens failed')
          }
        }
      }

      // Task 1.2 / 八股 08 §2.5：每次请求结束输出聚合用量与成本
      const costInput = (totalUsage.promptTokens / 1000) * config.MODEL_PRICE_INPUT_PER_1K
      const costOutput = (totalUsage.completionTokens / 1000) * config.MODEL_PRICE_OUTPUT_PER_1K
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
