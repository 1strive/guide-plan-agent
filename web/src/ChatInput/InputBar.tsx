import { useChatStore } from '../store/chatStore'
import { useStreamChat } from '../hooks/useStreamChat'

export function InputBar() {
  const input = useChatStore((s) => s.input)
  const setInput = useChatStore((s) => s.setInput)
  const sending = useChatStore((s) => s.sending)
  const activeId = useChatStore((s) => s.activeId)
  const pendingInterrupt = useChatStore((s) => s.pendingInterrupt)
  const currentRunId = useChatStore((s) => s.currentRunId)
  const { handleSend, handleStop } = useStreamChat()

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (pendingInterrupt) {
        handleSend({ id: pendingInterrupt.id, reason: pendingInterrupt.reason })
      } else {
        handleSend()
      }
    }
  }

  function onSendClick() {
    if (pendingInterrupt) {
      handleSend({ id: pendingInterrupt.id, reason: pendingInterrupt.reason })
    } else {
      handleSend()
    }
  }

  return (
    <div className="input-row">
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          pendingInterrupt
            ? `请回答：${pendingInterrupt.message}`
            : activeId
              ? '输入消息…'
              : '请先创建会话'
        }
        disabled={!activeId || sending}
      />
      {sending && currentRunId && (
        <button onClick={handleStop} className="btn-stop" title="主动停止当前 Run">
          停止
        </button>
      )}
      <button onClick={onSendClick} disabled={!activeId || sending}>
        发送
      </button>
    </div>
  )
}
