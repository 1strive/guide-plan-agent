import { useChatStore } from "../store/chatStore";
import {
  useSessionsQuery,
  useCreateSession,
  useDeleteSession,
} from "../query/useSessionQuery";
import { useStreamChat } from "../hooks/useStreamChat";
import { Button, Tag } from "./ui";
import * as api from "../api";
import type { ChatMsg } from "../types";

export function Sidebar() {
  const { data: sessions = [] } = useSessionsQuery();
  const activeId = useChatStore((s) => s.activeId);
  const createSession = useCreateSession();
  const deleteSession = useDeleteSession();
  const { startResume } = useStreamChat();

  async function handleNewSession() {
    const store = useChatStore.getState();
    store.abortInFlight();
    store.setSending(false);
    const data = await createSession.mutateAsync();
    await switchSession(data.sessionId);
  }

  async function switchSession(id: string) {
    const store = useChatStore.getState();
    store.abortInFlight();
    store.setSending(false);
    store.setActiveId(id);
    store.resetChat();

    let initialMessages: ChatMsg[] = [];
    let status: api.SessionStatus = "end";
    try {
      const data = await api.getSessionMessages(id);
      status = data.status;
      initialMessages = data.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
    } catch {
      initialMessages = [];
    }

    if (status === "running") {
      try {
        const { active } = await api.getActiveRun(id);
        if (
          active &&
          active.status !== "completed" &&
          active.status !== "cancelled" &&
          active.status !== "failed"
        ) {
          const lastMsg = initialMessages[initialMessages.length - 1];
          if (lastMsg && lastMsg.role === "assistant") {
            initialMessages = initialMessages.slice(0, -1);
          }
          store.setMessages(initialMessages);
          void startResume(id, active.runId);
          return;
        }
      } catch {
        // active 接口失败不阻断
      }
    }

    store.setMessages(initialMessages);
  }

  async function handleDeleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const session = sessions.find((s) => s.id === id);
    const title = session?.title || id.slice(0, 8) + "…";
    if (!confirm(`确定要删除会话「${title}」吗?该操作不可恢复。`)) return;

    if (id === activeId) {
      const store = useChatStore.getState();
      store.abortInFlight();
      store.setActiveId(null);
      store.resetChat();
      store.setSending(false);
    }
    await deleteSession.mutateAsync(id);
  }

  return (
    <aside className="w-[280px] min-w-[280px] flex flex-col bg-sidebar border-r border-sidebar-border">
      <div className="flex items-center justify-between px-5 py-4 border-b border-sidebar-border">
        <h2 className="text-base font-semibold text-[var(--title-default)]">
          会话历史
        </h2>
        <Button size="sm" onClick={handleNewSession}>
          + 新会话
        </Button>
      </div>
      <ul className="flex-1 overflow-y-auto px-3 py-3 list-none">
        {sessions.length === 0 && (
          <li className="text-center text-[13px] text-[var(--sidebar-weak)] py-8">
            暂无会话
          </li>
        )}
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <li
              key={s.id}
              className={
                "group relative px-3.5 py-3 mb-1.5 rounded-md cursor-pointer transition-colors duration-150 ease-in-out " +
                (active
                  ? "bg-sidebar-accent"
                  : "hover:bg-[var(--sidebar-button-hover)]")
              }
              onClick={() => switchSession(s.id)}
            >
              <span
                className={
                  "block text-sm truncate pr-6 " +
                  (active
                    ? "text-sidebar-accent-foreground font-medium"
                    : "text-foreground")
                }
              >
                {s.title || s.id.slice(0, 8) + "…"}
              </span>
              <span className="flex items-center justify-between mt-2">
                {s.totalTokens > 0 ? (
                  <Tag tone="primary" size="xs">
                    {s.totalTokens.toLocaleString()} tokens
                  </Tag>
                ) : (
                  <span />
                )}
                <span className="text-[11px] text-muted-foreground">
                  {new Date(s.createdAt).toLocaleDateString()}
                </span>
              </span>
              <button
                className="absolute top-2 right-2 w-6 h-6 inline-flex items-center justify-center rounded-md text-icon-weak opacity-0 group-hover:opacity-100 transition-all duration-150 ease-in-out hover:bg-destructive hover:text-destructive-foreground cursor-pointer leading-none"
                onClick={(e) => handleDeleteSession(s.id, e)}
                title="删除会话"
                aria-label="删除会话"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
