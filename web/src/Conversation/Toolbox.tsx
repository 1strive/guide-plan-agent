import { useState } from "react";
import { IconCopy, IconCheck, IconRetry } from "../components/Icons";

/**
 * 设计稿对齐：assistant 消息 hover 时浮现「重试 + 复制」工具栏。
 * 重试采用最小实现：只把上一条 user 文本回填输入框，不自动发送、不动历史。
 */
export function Toolbox({
  content,
  onRetry,
}: {
  content: string;
  onRetry?: () => void;
}) {
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
    <div className="flex items-center gap-0.5 mt-2 opacity-50 group-hover:opacity-100 transition-opacity duration-200">
      {onRetry && (
        <button
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] text-fg-muted hover:bg-surface-alt hover:text-foreground transition-colors"
          onClick={onRetry}
          title="将上一条提问回填输入框以便重发"
        >
          <IconRetry size={14} />
          重试
        </button>
      )}
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
