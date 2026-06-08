import { useChatStore } from '../store/chatStore'
import { useSessionsQuery } from '../query/useSessionQuery'

export function ChatHeader() {
  const activeId = useChatStore((s) => s.activeId)
  const { data: sessions = [] } = useSessionsQuery()
  const activeSession = sessions.find((s) => s.id === activeId)

  return (
    <header className="chat-header">
      <h1>Guide-Plan 旅游助手</h1>
      {activeSession && (
        <span className="chat-session-tag">
          {activeSession.title || activeSession.id.slice(0, 8) + '…'}
        </span>
      )}
    </header>
  )
}
