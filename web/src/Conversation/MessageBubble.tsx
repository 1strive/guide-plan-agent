import type { ChatMsg } from '../types'
import { TextContent } from './TextContent'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallChip } from './ToolCallChip'
import { InterruptCard } from '../ChatInput/InterruptCard'

export function MessageBubble({ msg }: { msg: ChatMsg }) {
  return (
    <div className={`message ${msg.role}${msg.interrupt ? ' interrupt' : ''}`}>
      {msg.interrupt && <div className="interrupt-badge">需要补充信息</div>}
      {msg.thinking && <ThinkingBlock thinking={msg.thinking} />}
      <TextContent content={msg.content} />
      {msg.interrupt && <InterruptCard interrupt={msg.interrupt} />}
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="tool-calls">
          {msg.toolCalls.map((tc, j) => (
            <ToolCallChip key={j} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  )
}
