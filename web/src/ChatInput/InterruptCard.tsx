import { useStreamChat } from '../hooks/useStreamChat'
import type { InterruptInfo } from '../types'
import { useChatStore } from '../store/chatStore'

export function InterruptCard({ interrupt }: { interrupt: InterruptInfo }) {
  const sending = useChatStore((s) => s.sending)
  const { handleOptionClick } = useStreamChat()

  if (!interrupt.options || interrupt.options.length === 0) return null

  return (
    <div className="interrupt-options">
      {interrupt.options.map((opt, idx) => (
        <button
          key={idx}
          className="option-btn"
          disabled={sending}
          onClick={() => handleOptionClick(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}
