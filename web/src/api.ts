import type { SessionItem, ChatMsgItem, SessionStatus, AgentRunRow, ResumeItem, AgUiEvent, InterruptQuestion } from './types'

export type { SessionItem, ChatMsgItem, SessionStatus, AgentRunRow, ResumeItem, AgUiEvent }

export type SessionMessagesResponse = {
  messages: ChatMsgItem[]
  status: SessionStatus
  pendingInterrupt: {
    questions: InterruptQuestion[]
  } | null
}

const BASE = '/api'

export async function checkHealth() {
  const res = await fetch(`${BASE}/health`)
  return res.json() as Promise<{ ok: boolean; db: boolean }>
}

export async function createSession() {
  const res = await fetch(`${BASE}/sessions`, { method: 'POST' })
  return res.json() as Promise<{ sessionId: string }>
}

export async function deleteSession(sessionId: string) {
  const res = await fetch(`${BASE}/sessions/${sessionId}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete failed: ${res.status}`)
  }
}

export async function batchDeleteSessions(ids: string[]) {
  const res = await fetch(`${BASE}/sessions/batch`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!res.ok) {
    throw new Error(`batch delete failed: ${res.status}`)
  }
  return res.json() as Promise<{ deleted: number }>
}

export async function listSessions() {
  const res = await fetch(`${BASE}/sessions`)
  return res.json() as Promise<{ sessions: SessionItem[] }>
}

export async function getSessionMessages(sessionId: string) {
  const res = await fetch(`${BASE}/sessions/${sessionId}/messages`)
  return res.json() as Promise<SessionMessagesResponse>
}

export async function getActiveRun(sessionId: string) {
  const res = await fetch(`${BASE}/sessions/${sessionId}/runs/active`)
  if (!res.ok) throw new Error(`getActiveRun failed: ${res.status}`)
  return res.json() as Promise<{ active: AgentRunRow | null }>
}

export async function cancelRun(sessionId: string, runId: string) {
  const res = await fetch(`${BASE}/sessions/${sessionId}/runs/${runId}/cancel`, {
    method: 'POST',
  })
  if (!res.ok && res.status !== 202) {
    throw new Error(`cancelRun failed: ${res.status}`)
  }
}

// ─── AG-UI 协议流式请求 ───

export async function* sendMessageStream(
  sessionId: string,
  message: string,
  resume?: ResumeItem[],
  signal?: AbortSignal,
): AsyncGenerator<AgUiEvent> {
  const body: Record<string, unknown> = { message }
  if (resume && resume.length > 0) {
    body.resume = resume
  }
  const res = await fetch(`${BASE}/sessions/${sessionId}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`stream failed: ${res.status} ${errText}`)
  }
  yield* parseSseStream(res.body!.getReader())
}

export async function* resumeRunStream(
  sessionId: string,
  runId: string,
  afterSeq: number = 0,
  signal?: AbortSignal,
): AsyncGenerator<AgUiEvent> {
  const url = `${BASE}/sessions/${sessionId}/runs/${runId}/stream?after_seq=${afterSeq}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`resume failed: ${res.status} ${errText}`)
  }
  yield* parseSseStream(res.body!.getReader())
}

async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<AgUiEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data: ')) {
        yield JSON.parse(trimmed.slice(6))
      }
    }
  }
}
