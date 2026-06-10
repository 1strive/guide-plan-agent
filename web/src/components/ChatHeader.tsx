import { useChatStore } from "../store/chatStore";
import { useSessionsQuery } from "../query/useSessionQuery";
import { Tag } from "./ui";

export function ChatHeader() {
  const activeId = useChatStore((s) => s.activeId);
  const { data: sessions = [] } = useSessionsQuery();
  const activeSession = sessions.find((s) => s.id === activeId);

  return (
    <header className="flex items-center gap-3 px-1">
      <h1 className="text-xl font-semibold text-title-default">
        Guide-Plan 旅游助手
      </h1>
      {activeSession && (
        <Tag tone="neutral" className="rounded-xl px-3 py-1">
          {activeSession.title || activeSession.id.slice(0, 8) + "…"}
        </Tag>
      )}
    </header>
  );
}
