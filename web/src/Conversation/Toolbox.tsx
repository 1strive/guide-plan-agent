import { useState } from "react";
import { IconCopy, IconCheck } from "../components/Icons";

export function Toolbox({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  }

  return (
    <div className="flex items-center gap-0.5 mt-2">
      <button
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] text-fg-muted hover:bg-surface-alt hover:text-foreground transition-colors"
        onClick={handleCopy}
      >
        {copied ? (
          <>
            <IconCheck size={14} className="text-success" />
            <span className="text-success">已复制</span>
          </>
        ) : (
          <>
            <IconCopy size={14} />
            复制
          </>
        )}
      </button>
    </div>
  );
}
