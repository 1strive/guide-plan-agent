import type { ChatMsg } from "../types";
import { TextContent } from "./TextContent";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallChip } from "./ToolCallChip";
import { InterruptCard } from "../ChatInput/InterruptCard";
import { Toolbox } from "./Toolbox";
import { QuickReplies } from "./QuickReplies";
import { IconCompass } from "../components/Icons";
import { useChatStore } from "../store/chatStore";

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end mb-8">
      <div className="bg-user-bg text-user-fg px-4 py-3 rounded-2xl rounded-br-md max-w-[560px] text-[14px] leading-[1.7] whitespace-pre-wrap break-words shadow-card">
        {content}
      </div>
    </div>
  );
}

function AssistantBubble({
  msg,
  prevUserContent,
}: {
  msg: ChatMsg;
  prevUserContent?: string;
}) {
  // 设计稿对齐：重试 = 把上一条 user 文本回填输入框，不动发送与历史
  const handleRetry = prevUserContent
    ? () => useChatStore.getState().setInput(prevUserContent)
    : undefined;

  return (
    <div className="flex gap-4 items-start mb-8 group">
      <div className="w-8 h-8 rounded-lg bg-accent-soft text-primary grid place-items-center flex-shrink-0 mt-0.5 shadow-subtle">
        <IconCompass size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-muted-foreground mb-2">
          路书
        </div>
        {msg.interrupt && !msg.interrupt.selectedAnswer && (
          <div className="inline-block px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-semibold mb-3 shadow-mist">
            需要补充信息
          </div>
        )}
        {msg.thinking && <ThinkingBlock thinking={msg.thinking} />}
        <TextContent content={msg.content} />
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-4">
            {msg.toolCalls.map((tc, j) => (
              <ToolCallChip key={j} toolCall={tc} />
            ))}
          </div>
        )}
        {msg.interrupt && <InterruptCard interrupt={msg.interrupt} />}
        {msg.content && <Toolbox content={msg.content} onRetry={handleRetry} />}
        {msg.quickReplies && <QuickReplies options={msg.quickReplies} />}
      </div>
    </div>
  );
}

export function MessageBubble({
  msg,
  prevUserContent,
}: {
  msg: ChatMsg;
  prevUserContent?: string;
}) {
  if (msg.role === "user") {
    return <UserBubble content={msg.content} />;
  }
  return <AssistantBubble msg={msg} prevUserContent={prevUserContent} />;
}
