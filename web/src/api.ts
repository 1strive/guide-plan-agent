const BASE = '/api'

export type SessionItem = {
    id: string
    title: string | null
    createdAt: string
}

export type ChatMsgItem = {
    role: 'user' | 'assistant' | 'system'
    content: string
}

export async function checkHealth() {
    const res = await fetch(`${BASE}/health`)
    return res.json() as Promise<{ ok: boolean; db: boolean }>
}

export async function createSession() {
    const res = await fetch(`${BASE}/sessions`, { method: 'POST' })
    return res.json() as Promise<{ sessionId: string }>
}

export async function listSessions() {
    const res = await fetch(`${BASE}/sessions`)
    return res.json() as Promise<{ sessions: SessionItem[] }>
}

export async function getSessionMessages(sessionId: string) {
    const res = await fetch(`${BASE}/sessions/${sessionId}/messages`)
    return res.json() as Promise<{ messages: ChatMsgItem[] }>
}

export async function sendMessage(sessionId: string, message: string) {
    const res = await fetch(`${BASE}/sessions/${sessionId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
    })
    return res.json() as Promise<{ reply: string; referencedDestinationIds: number[] }>
}

// ─── AG-UI 协议流式请求 ───
export type AgUiEvent = {
    type: string
    [key: string]: unknown
}

export async function* sendMessageStream(
    sessionId: string,
    message: string
): AsyncGenerator<AgUiEvent> {
    const res = await fetch(`${BASE}/sessions/${sessionId}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
    })
    if (!res.ok) {
        const errText = await res.text()
        throw new Error(`stream failed: ${res.status} ${errText}`)
    }
    const reader = res.body!.getReader()
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
