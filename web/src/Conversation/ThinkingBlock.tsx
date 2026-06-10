/**
 * ThinkingBlock — 折叠的思考过程块
 * 颜色严格走 token：底 muted、字 muted-foreground。
 */
export function ThinkingBlock({ thinking }: { thinking: string }) {
  return (
    <details className="mb-3 text-[0.85em] text-muted-foreground">
      <summary className="cursor-pointer select-none py-1">思考过程</summary>
      <pre className="mt-2 px-3 py-2.5 bg-muted rounded-md whitespace-pre-wrap break-words font-[inherit] text-[inherit] leading-relaxed">
        {thinking}
      </pre>
    </details>
  );
}
