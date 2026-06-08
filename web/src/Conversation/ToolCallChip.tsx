import type { ToolCallInfo } from '../types'

export function ToolCallChip({ toolCall }: { toolCall: ToolCallInfo }) {
  return (
    <span className={`tool-tag ${toolCall.status}`}>
      {toolCall.status === 'running' ? '⏳' : '✅'} {toolCall.name}
    </span>
  )
}
