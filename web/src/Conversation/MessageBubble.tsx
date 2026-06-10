import type { ChatMsg } from "../types";
import { TextContent } from "./TextContent";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallChip } from "./ToolCallChip";
import { InterruptCard } from "../ChatInput/InterruptCard";

/**
 * 消息气泡 — 样式严格遵循 DESIGN.md §7.4 Message Bubble
 * - user      主色底反白字，右对齐，右下角收角
 * - assistant 卡片底，左对齐，左下角收角
 * - interrupt 营营负背景 + accent 描边，顶部带徽章
 */
const BASE =
  "max-w-[80%] px-4 py-3 rounded-lg text-sm leading-relaxed whitespace-pre-wrap break-words";

const USER_CLS = "bg-primary text-primary-foreground ml-auto rounded-br-sm";
const AI_CLS =
  "bg-card text-card-foreground border border-border mr-auto rounded-bl-sm";
const INTERRUPT_CLS =
  "bg-[color-mix(in_srgb,var(--accent)_10%,var(--card))] text-card-foreground border border-accent mr-auto rounded-bl-sm";

export function MessageBubble({ msg }: { msg: ChatMsg }) {
  const cls = msg.interrupt
    ? `${BASE} ${INTERRUPT_CLS}`
    : msg.role === "user"
      ? `${BASE} ${USER_CLS}`
      : `${BASE} ${AI_CLS}`;

  return (
    <div className={cls}>
      {msg.interrupt && (
        <div className="inline-block px-3 py-1 rounded-[10px] bg-accent text-accent-foreground text-xs font-semibold mb-2.5">
          需要补充信息
        </div>
      )}
      {msg.thinking && <ThinkingBlock thinking={msg.thinking} />}
      <TextContent content={msg.content} />
      {msg.interrupt && <InterruptCard interrupt={msg.interrupt} />}
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {msg.toolCalls.map((tc, j) => (
            <ToolCallChip key={j} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
}
