// ─── 后端 API 响应类型 ───

export type SessionItem = {
  id: string
  title: string | null
  totalTokens: number
  createdAt: string
  /** Sidebar 设计稿对齐：最近一条消息内容（任意 role），用于会话项 preview 行 */
  lastMessage: string | null
  /** Sidebar 设计稿对齐：user+assistant 消息数，用于会话项 badge */
  messageCount: number
}

export type ChatMsgItem = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type SessionStatus = 'running' | 'end'

export type AgentRunRow = {
  runId: string
  sessionId: string
  status: 'pending' | 'running' | 'completed' | 'interrupted' | 'cancelling' | 'cancelled' | 'failed'
  startedAt: string
  finishedAt: string | null
  lastEventSeq: number
  totalTokens: number
}

export type ResumeItem = {
  interruptId: string
  status: 'resolved' | 'cancelled'
  payload?: Record<string, unknown>
}

export type AgUiEvent = {
  type: string
  [key: string]: unknown
}

// ─── 前端 UI 模型 ───

export type ToolCallInfo = {
  name: string
  status: 'running' | 'done'
}

export type InterruptInfo = {
  id: string
  message: string
  reason: string
  options?: string[]
}

export type ChatMsg = {
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  toolCalls?: ToolCallInfo[]
  interrupt?: InterruptInfo
  quickReplies?: string[]
}
