import { useRef, useEffect } from 'react'
import { useChatStore } from '../store/chatStore'
import { MessageBubble } from './MessageBubble'

export function MessageList() {
  const messages = useChatStore((s) => s.messages)
  const sending = useChatStore((s) => s.sending)
  const activeId = useChatStore((s) => s.activeId)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const showLoading =
    sending &&
    !messages.some(
      (m, idx) =>
        m.role === 'assistant' &&
        idx === messages.length - 1 &&
        m.toolCalls &&
        m.toolCalls.length > 0,
    )

  return (
    <div className="chat-box">
      {messages.length === 0 && (
        <div className="placeholder">
          {activeId ? '输入消息开始聊天' : '点击左侧「+ 新会话」开始'}
        </div>
      )}
      {messages.map((msg, i) => (
        <MessageBubble key={i} msg={msg} />
      ))}
      {showLoading && <div className="message assistant loading">思考中…</div>}
      <div ref={chatEndRef} />
    </div>
  )
}
