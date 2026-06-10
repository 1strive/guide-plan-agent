import { useRef, useEffect } from "react";
import { useChatStore } from "../store/chatStore";
import { MessageBubble } from "./MessageBubble";

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
    <div className="flex-1 overflow-y-auto rounded-xl border border-border bg-card shadow-card px-6 py-5 space-y-3">
      {messages.length === 0 && (
        <div className="text-center text-icon-weak text-sm pt-[40%]">
          {activeId ? "输入消息开始聊天" : "点击左侧「+ 新会话」开始"}
        </div>
      )}
      {messages.map((msg, i) => (
        <MessageBubble key={i} msg={msg} />
      ))}
      {showLoading && (
        <div className="max-w-[80%] mr-auto px-4 py-3 rounded-lg rounded-bl-sm bg-card border border-border text-muted-foreground italic text-sm leading-relaxed">
          思考中…
        </div>
      )}
      <div ref={chatEndRef} />
    </div>
  );
}
