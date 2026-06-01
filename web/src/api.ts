const BASE = '/api'

export type SessionItem = {
    id: string
    title: string | null
    totalTokens: number
    createdAt: string
}

export type ChatMsgItem = {
    role: 'user' | 'assistant' | 'system'
    content: string
}

// Task 整合-2:GET /messages 加 status 字段
export type SessionStatus = 'running' | 'end'

// Task 整合-2:活跃 Run 元数据(GET /runs/active 返回)
export type AgentRunRow = {
    runId: string
    sessionId: string
    status: 'pending' | 'running' | 'completed' | 'interrupted' | 'cancelling' | 'cancelled' | 'failed'
    startedAt: string
    finishedAt: string | null
    lastEventSeq: number
    totalTokens: number
}

export async function checkHealth() {
    const res = await fetch(`${BASE}/health`)
    return res.json() as Promise<{ ok: boolean; db: boolean }>
}

export async function createSession() {
    const res = await fetch(`${BASE}/sessions`, { method: 'POST' })
    return res.json() as Promise<{ sessionId: string }>
}

// 八股 05-记忆系统.md §3.2.2 CRUD「删」:幂等删除,404 视为已删除
export async function deleteSession(sessionId: string) {
    const res = await fetch(`${BASE}/sessions/${sessionId}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) {
        throw new Error(`delete failed: ${res.status}`)
    }
}

export async function listSessions() {
    const res = await fetch(`${BASE}/sessions`)
    return res.json() as Promise<{ sessions: SessionItem[] }>
}

// Task 整合-2:返回值含 status,running 时前端据此发起续订
export async function getSessionMessages(sessionId: string) {
    const res = await fetch(`${BASE}/sessions/${sessionId}/messages`)
    return res.json() as Promise<{ messages: ChatMsgItem[]; status: SessionStatus }>
}

// Task 整合-2:查会话最近未完成的 Run(供续订)
export async function getActiveRun(sessionId: string) {
    const res = await fetch(`${BASE}/sessions/${sessionId}/runs/active`)
    if (!res.ok) throw new Error(`getActiveRun failed: ${res.status}`)
    return res.json() as Promise<{ active: AgentRunRow | null }>
}

// Task 整合-2:用户主动取消 Run(202 + 幂等)
export async function cancelRun(sessionId: string, runId: string) {
    const res = await fetch(`${BASE}/sessions/${sessionId}/runs/${runId}/cancel`, {
        method: 'POST'
    })
    if (!res.ok && res.status !== 202) {
        throw new Error(`cancelRun failed: ${res.status}`)
    }
}

// ─── AG-UI 协议流式请求 ───
export type ResumeItem = {
    interruptId: string
    status: 'resolved' | 'cancelled'
    payload?: Record<string, unknown>
}

export type AgUiEvent = {
    type: string
    [key: string]: unknown
}

// 八股 08-工程化实践.md §1 容错:signal 让调用方可在切换/删除会话时主动 abort
// 注:整合-2 后 abort 只是"前端断开 SSE",后端 Run 继续跑,不再终止
export async function* sendMessageStream(
    sessionId: string,
    message: string,
    resume?: ResumeItem[],
    signal?: AbortSignal
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

// Task 整合-2:续订接口 GET /runs/:runId/stream?after_seq=N
// 先收到回放历史事件,然后接实时流(若 Run 仍活跃)
export async function* resumeRunStream(
    sessionId: string,
    runId: string,
    afterSeq: number = 0,
    signal?: AbortSignal
): AsyncGenerator<AgUiEvent> {
    const url = `${BASE}/sessions/${sessionId}/runs/${runId}/stream?after_seq=${afterSeq}`
    const res = await fetch(url, { signal })
    if (!res.ok) {
        const errText = await res.text()
        throw new Error(`resume failed: ${res.status} ${errText}`)
    }
    yield* parseSseStream(res.body!.getReader())
}

// SSE 流公共解析,两个流接口复用
async function* parseSseStream(
    reader: ReadableStreamDefaultReader<Uint8Array>
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
