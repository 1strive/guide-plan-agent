import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config.js'
import { createPool } from './db/pool.js'
import { createSession, insertMessage, listRecentMessages, sessionExists } from './db/chatRepo.js'
import { SYSTEM_PROMPT } from './agent/prompts.js'
import { runAgentWithTools, type ChatMessage } from './agent/llm.js'

async function main() {
  const config = loadConfig()
  const pool = createPool(config)
  const app = Fastify({ logger: true })

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

  app.post('/sessions', async (_req, reply) => {
    const id = randomUUID()
    await createSession(pool, id)
    reply.status(201)
    return { sessionId: id }
  })

  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    '/sessions/:id/chat',
    async (req, reply) => {
      const sessionId = req.params.id
      const message = req.body?.message?.trim()
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

      const result = await runAgentWithTools(pool, config, msgs)
      await insertMessage(pool, sessionId, 'assistant', result.content)

      return {
        reply: result.content,
        referencedDestinationIds: result.referencedDestinationIds
      }
    }
  )

  await app.listen({ port: config.PORT, host: '0.0.0.0' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
