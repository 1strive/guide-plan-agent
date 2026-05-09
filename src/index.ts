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
import { runAgentStream, type ChatMessage } from './agent/llm.js'
import { EventType } from './agent/ag-ui.js'

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

  app.post<{ Params: { id: string }; Body: { message?: string; threadId?: string; runId?: string } }>(
    '/sessions/:id/stream',
    async (req, reply) => {
      const sessionId = req.params.id
      const message = req.body?.message?.trim()
      const threadId = req.body?.threadId ?? sessionId
      const runId = req.body?.runId ?? randomUUID()

      if (!message) {
        reply.status(400)
        return { error: 'message required' }
      }
      const exists = await sessionExists(pool, sessionId)
      if (!exists) {
        reply.status(404)
        return { error: 'session not found' }
      }

      await insertMessage(pool, sessionId, 'user', message)
      const history = await listRecentMessages(pool, sessionId, config.CHAT_HISTORY_LIMIT)

      const msgs: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }]
      for (const h of history) {
        if (h.role === 'user' || h.role === 'assistant') {
          msgs.push({ role: h.role, content: h.content })
        }
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      })

      let fullContent = ''
      for await (const event of runAgentStream(pool, config, msgs, threadId, runId)) {
        if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
          fullContent += event.delta
        }
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      }

      if (fullContent) {
        await insertMessage(pool, sessionId, 'assistant', fullContent)
      }

      const existing = await getSessionMessages(pool, sessionId)
      if (existing.filter(m => m.role === 'user').length === 1) {
        const title = message.length > 30 ? message.slice(0, 30) + '…' : message
        await updateSessionTitle(pool, sessionId, title)
      }

      reply.raw.end()
    }
  )

  await app.listen({ port: config.PORT, host: '0.0.0.0' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
