import { useChatStore } from "../store/chatStore";
import { useSessionsQuery } from "../query/useSessionQuery";
import { IconShare, IconDots } from "./Icons";

export function ChatHeader() {
  const activeId = useChatStore((s) => s.activeId);
  const { data: sessions = [] } = useSessionsQuery();
  const activeSession = sessions.find((s) => s.id === activeId);

  const title = activeSession?.title || "路书";

  return (
    <header className="flex items-center gap-4 px-8 py-4 border-b border-border bg-surface flex-shrink-0">
      <h1 className="text-[16px] font-semibold text-foreground flex-1 truncate">
        {title}
      </h1>
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
        已连接
      </div>
      <div className="flex items-center gap-1">
        <button
          className="w-9 h-9 rounded-lg grid place-items-center text-muted-foreground hover:bg-surface-alt hover:text-foreground transition-colors"
          title="分享"
        >
          <IconShare size={17} />
        </button>
        <button
          className="w-9 h-9 rounded-lg grid place-items-center text-muted-foreground hover:bg-surface-alt hover:text-foreground transition-colors"
          title="更多"
        >
          <IconDots size={17} />
        </button>
      </div>
    </header>
  );
}
