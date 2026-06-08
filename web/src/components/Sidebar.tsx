import { useChatStore } from '../store/chatStore'
import { useSessionsQuery, useCreateSession, useDeleteSession } from '../query/useSessionQuery'
import { useStreamChat } from '../hooks/useStreamChat'
import * as api from '../api'
import type { ChatMsg } from '../types'

export function Sidebar() {
  const { data: sessions = [] } = useSessionsQuery()
  const activeId = useChatStore((s) => s.activeId)
  const createSession = useCreateSession()
  const deleteSession = useDeleteSession()
  const { startResume } = useStreamChat()

  async function handleNewSession() {
    const store = useChatStore.getState()
    store.abortInFlight()
    store.setSending(false)
    const data = await createSession.mutateAsync()
    await switchSession(data.sessionId)
  }

  async function switchSession(id: string) {
    const store = useChatStore.getState()
    store.abortInFlight()
    store.setSending(false)
    store.setActiveId(id)
    store.resetChat()

    let initialMessages: ChatMsg[] = []
    let status: api.SessionStatus = 'end'
    try {
      const data = await api.getSessionMessages(id)
      status = data.status
      initialMessages = data.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    } catch {
      initialMessages = []
    }

    if (status === 'running') {
      try {
        const { active } = await api.getActiveRun(id)
        if (active && active.status !== 'completed' && active.status !== 'cancelled' && active.status !== 'failed') {
          const lastMsg = initialMessages[initialMessages.length - 1]
          if (lastMsg && lastMsg.role === 'assistant') {
            initialMessages = initialMessages.slice(0, -1)
          }
          store.setMessages(initialMessages)
          void startResume(id, active.runId)
          return
        }
      } catch {
        // active 接口失败不阻断
      }
    }

    store.setMessages(initialMessages)
  }

  async function handleDeleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    const session = sessions.find((s) => s.id === id)
    const title = session?.title || id.slice(0, 8) + '…'
    if (!confirm(`确定要删除会话「${title}」吗?该操作不可恢复。`)) return

    if (id === activeId) {
      const store = useChatStore.getState()
      store.abortInFlight()
      store.setActiveId(null)
      store.resetChat()
      store.setSending(false)
    }
    await deleteSession.mutateAsync(id)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>会话历史</h2>
        <button className="btn-new" onClick={handleNewSession}>
          + 新会话
        </button>
      </div>
      <ul className="session-list">
        {sessions.length === 0 && <li className="session-empty">暂无会话</li>}
        {sessions.map((s) => (
          <li
            key={s.id}
            className={`session-item ${s.id === activeId ? 'active' : ''}`}
            onClick={() => switchSession(s.id)}
          >
            <span className="session-title">{s.title || s.id.slice(0, 8) + '…'}</span>
            <span className="session-meta">
              {s.totalTokens > 0 && (
                <span className="session-tokens">{s.totalTokens.toLocaleString()} tokens</span>
              )}
              <span className="session-time">{new Date(s.createdAt).toLocaleDateString()}</span>
            </span>
            <button
              className="session-delete"
              onClick={(e) => handleDeleteSession(s.id, e)}
              title="删除会话"
              aria-label="删除会话"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
