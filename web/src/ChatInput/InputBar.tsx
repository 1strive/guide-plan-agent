import { useChatStore } from "../store/chatStore";
import { useStreamChat } from "../hooks/useStreamChat";
import { Button } from "../components/ui";

export function InputBar() {
  const input = useChatStore((s) => s.input);
  const setInput = useChatStore((s) => s.setInput);
  const sending = useChatStore((s) => s.sending);
  const activeId = useChatStore((s) => s.activeId);
  const pendingInterrupt = useChatStore((s) => s.pendingInterrupt);
  const currentRunId = useChatStore((s) => s.currentRunId);
  const { handleSend, handleStop } = useStreamChat();

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (pendingInterrupt) {
        handleSend({
          id: pendingInterrupt.id,
          reason: pendingInterrupt.reason,
        });
      } else {
        handleSend();
      }
    }
  }

  function onSendClick() {
    if (pendingInterrupt) {
      handleSend({ id: pendingInterrupt.id, reason: pendingInterrupt.reason });
    } else {
      handleSend();
    }
  }

  return (
    <div className="flex gap-3 items-stretch pt-1">
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          pendingInterrupt
            ? `请回答：${pendingInterrupt.message}`
            : activeId
              ? "输入消息…"
              : "请先创建会话"
        }
        disabled={!activeId || sending}
        className="flex-1 h-14 px-5 rounded-lg text-sm bg-input text-foreground placeholder:text-muted-foreground border border-border outline-none transition-colors duration-150 ease-in-out focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:opacity-60 disabled:cursor-not-allowed"
      />
      {sending && currentRunId && (
        <Button
          variant="ghost"
          size="xl"
          onClick={handleStop}
          title="主动停止当前 Run"
        >
          停止
        </Button>
      )}
      <Button size="xl" onClick={onSendClick} disabled={!activeId || sending}>
        发送
      </Button>
    </div>
  );
}
