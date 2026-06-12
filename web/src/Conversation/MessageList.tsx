import { useRef, useEffect } from "react";
import { useChatStore } from "../store/chatStore";
import { MessageBubble } from "./MessageBubble";
import { WelcomeBanner } from "./WelcomeBanner";
import { IconCompass } from "../components/Icons";

export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const sending = useChatStore((s) => s.sending);
  const activeId = useChatStore((s) => s.activeId);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-8 py-6">
        {messages.length === 0 && (
          <div className="pt-12">
            {activeId ? (
              <WelcomeBanner />
            ) : (
              <div className="text-center text-fg-subtle text-sm">
                点击左侧「开始新旅行」创建会话
              </div>
            )}
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}
        {showLoading && (
          <div className="flex gap-3 items-start mb-6">
            <div className="w-7 h-7 rounded-lg bg-accent-soft text-primary grid place-items-center flex-shrink-0 mt-0.5">
              <IconCompass size={16} />
            </div>
            <div className="flex-1">
              <div className="text-xs font-semibold text-fg-muted mb-1.5">
                路书
              </div>
              <div className="text-sm text-fg-muted italic">思考中…</div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>
    </div>
  );
}
