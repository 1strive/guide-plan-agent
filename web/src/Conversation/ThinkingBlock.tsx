export function ThinkingBlock({ thinking }: { thinking: string }) {
  return (
    <details
      className="message-thinking"
      style={{ margin: '0 0 8px 0', fontSize: '0.85em', color: '#888' }}
    >
      <summary style={{ cursor: 'pointer', userSelect: 'none' }}>思考过程</summary>
      <pre
        style={{
          margin: '6px 0 0 0',
          padding: '8px 10px',
          background: 'rgba(0,0,0,0.04)',
          borderRadius: 4,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'inherit',
          fontSize: 'inherit',
        }}
      >
        {thinking}
      </pre>
    </details>
  )
}
