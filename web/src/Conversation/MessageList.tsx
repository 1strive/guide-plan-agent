import { useRef, useEffect, useCallback } from "react";
import { useChatStore } from "../store/chatStore";
import { MessageBubble } from "./MessageBubble";
import { WelcomeBanner } from "./WelcomeBanner";
import { ScrollToBottom } from "./ScrollToBottom";
import { IconCompass } from "../components/Icons";

/** 距底部多少 px 以内视为「在底部附近」，自动滚动才生效 */
const AUTO_SCROLL_THRESHOLD = 30;

export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const sending = useChatStore((s) => s.sending);
  const activeId = useChatStore((s) => s.activeId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  console.log("[messages]:", messages);

  /** 判断滚动容器当前是否在底部阈值内 */
  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return (
      el.scrollHeight - el.scrollTop - el.clientHeight <= AUTO_SCROLL_THRESHOLD
    );
  }, []);

  // 新消息到达时：仅当用户在底部附近才自动滚动，避免打断历史浏览
  useEffect(() => {
    if (isNearBottom()) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isNearBottom]);

  const showLoading =
    sending &&
    !messages.some(
      (m, idx) =>
        m.role === "assistant" &&
        idx === messages.length - 1 &&
        m.toolCalls &&
        m.toolCalls.length > 0,
    );

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto relative message-list-scroll"
    >
      <div className="max-w-[760px] mx-auto px-10 py-8">
        {messages.length === 0 && (
          <div className="pt-8">
            {activeId ? (
              <WelcomeBanner />
            ) : (
              <div className="text-center text-muted-foreground text-sm py-20">
                点击左侧「开始新旅行」创建会话
              </div>
            )}
          </div>
        )}
        {messages.map((msg, i) => {
          // 设计稿对齐：assistant Toolbox 重试需要上一条 user 文本
          const prev = messages[i - 1];
          const prevUserContent =
            msg.role === "assistant" && prev?.role === "user"
              ? prev.content
              : undefined;
          return (
            <MessageBubble
              key={i}
              msg={msg}
              prevUserContent={prevUserContent}
            />
          );
        })}
        {showLoading && (
          <div className="flex gap-4 items-start mb-8">
            <div className="w-8 h-8 rounded-lg bg-accent-soft text-primary grid place-items-center flex-shrink-0 mt-0.5 shadow-subtle">
              <IconCompass size={18} />
            </div>
            <div className="flex-1">
              <div className="text-xs font-semibold text-muted-foreground mb-2">
                路书
              </div>
              <div className="text-sm text-muted-foreground italic">
                思考中…
              </div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>
      <ScrollToBottom containerRef={scrollRef} />
    </div>
  );
}
