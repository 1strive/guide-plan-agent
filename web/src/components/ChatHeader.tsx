import { useChatStore } from "../store/chatStore";
import { useSessionsQuery } from "../query/useSessionQuery";
import { IconShare, IconDots } from "./Icons";

export function ChatHeader() {
  const activeId = useChatStore((s) => s.activeId);
  const { data: sessions = [] } = useSessionsQuery();
  const activeSession = sessions.find((s) => s.id === activeId);

  const title = activeSession?.title || "路书";

  return (
    <header className="flex items-center gap-3 px-6 py-3.5 border-b border-border bg-surface flex-shrink-0">
      <h1 className="text-[15px] font-semibold text-foreground flex-1 truncate">
        {title}
      </h1>
      <div className="flex items-center gap-1.5 text-[12px] text-fg-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-success" />
        已连接
      </div>
      <div className="flex items-center gap-1">
        <button
          className="w-8 h-8 rounded-lg grid place-items-center text-fg-muted hover:bg-surface-alt hover:text-foreground transition-colors"
          title="分享"
        >
          <IconShare size={16} />
        </button>
        <button
          className="w-8 h-8 rounded-lg grid place-items-center text-fg-muted hover:bg-surface-alt hover:text-foreground transition-colors"
          title="更多"
        >
          <IconDots size={16} />
        </button>
      </div>
    </header>
  );
}
