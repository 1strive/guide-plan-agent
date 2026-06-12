import { useRef } from "react";
import { useChatStore } from "../store/chatStore";
import { useStreamChat } from "../hooks/useStreamChat";
import {
  IconUpload,
  IconLocation,
  IconMic,
  IconSend,
} from "../components/Icons";

export function InputBar() {
  const input = useChatStore((s) => s.input);
  const setInput = useChatStore((s) => s.setInput);
  const sending = useChatStore((s) => s.sending);
  const activeId = useChatStore((s) => s.activeId);
  const pendingInterrupt = useChatStore((s) => s.pendingInterrupt);
  const currentRunId = useChatStore((s) => s.currentRunId);
  const { handleSend, handleStop } = useStreamChat();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  }

  function doSend() {
    if (pendingInterrupt) {
      handleSend({ id: pendingInterrupt.id, reason: pendingInterrupt.reason });
    } else {
      handleSend();
    }
  }

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  const canSend = activeId && !sending && input.trim().length > 0;

  return (
    <div className="px-8 pb-6 flex-shrink-0">
      <div className="max-w-[760px] mx-auto">
        <div className="bg-surface border border-border rounded-2xl shadow-card overflow-hidden focus-within:border-primary transition-colors">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoResize();
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              pendingInterrupt
                ? `请回答：${pendingInterrupt.message}`
                : activeId
                  ? "继续聊…"
                  : "请先创建会话"
            }
            disabled={!activeId || sending}
            rows={1}
            className="w-full px-4.5 pt-3.5 pb-2 border-none outline-none resize-none text-sm leading-relaxed bg-transparent min-h-[48px] max-h-[160px] text-foreground placeholder:text-fg-subtle disabled:opacity-60 disabled:cursor-not-allowed"
          />
          <div className="flex items-center px-2 py-1.5 pb-2 gap-1">
            <button
              className="w-8 h-8 rounded-lg grid place-items-center text-fg-muted hover:bg-surface-alt hover:text-foreground transition-colors"
              title="上传文件"
              tabIndex={-1}
            >
              <IconUpload size={18} />
            </button>
            <button
              className="w-8 h-8 rounded-lg grid place-items-center text-fg-muted hover:bg-surface-alt hover:text-foreground transition-colors"
              title="添加位置"
              tabIndex={-1}
            >
              <IconLocation size={18} />
            </button>
            <button
              className="w-8 h-8 rounded-lg grid place-items-center text-fg-muted hover:bg-surface-alt hover:text-foreground transition-colors"
              title="语音输入"
              tabIndex={-1}
            >
              <IconMic size={18} />
            </button>
            <div className="flex-1" />
            {sending && currentRunId && (
              <button
                className="px-3 h-8 rounded-lg text-[12px] font-medium text-fg-muted hover:bg-surface-alt hover:text-foreground transition-colors"
                onClick={handleStop}
                title="主动停止当前 Run"
              >
                停止
              </button>
            )}
            <button
              className="w-8 h-8 rounded-lg bg-primary text-primary-foreground grid place-items-center hover:bg-accent-hover disabled:bg-border disabled:cursor-default transition-colors"
              onClick={doSend}
              disabled={!canSend}
              title="发送"
            >
              <IconSend size={16} />
            </button>
          </div>
        </div>
        <div className="text-center text-[11px] text-fg-subtle mt-2">
          Enter 发送 · Shift+Enter 换行
        </div>
      </div>
    </div>
  );
}
