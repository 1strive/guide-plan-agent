import { useState } from "react";
import { useChatStore } from "../store/chatStore";
import {
  useSessionsQuery,
  useCreateSession,
  useDeleteSession,
} from "../query/useSessionQuery";
import { useStreamChat } from "../hooks/useStreamChat";
import { IconPlus, IconSearch, IconRoute } from "./Icons";
import * as api from "../api";
import type { SessionItem, ChatMsg } from "../types";

function groupSessionsByTime(sessions: SessionItem[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const yesterdayMs = todayMs - 86_400_000;
  const weekMs = todayMs - 7 * 86_400_000;

  const groups: { label: string; items: SessionItem[] }[] = [
    { label: "今天", items: [] },
    { label: "昨天", items: [] },
    { label: "近 7 天", items: [] },
    { label: "更早", items: [] },
  ];

  for (const s of sessions) {
    const t = new Date(s.createdAt).getTime();
    if (t >= todayMs) groups[0]!.items.push(s);
    else if (t >= yesterdayMs) groups[1]!.items.push(s);
    else if (t >= weekMs) groups[2]!.items.push(s);
    else groups[3]!.items.push(s);
  }

  return groups.filter((g) => g.items.length > 0);
}

export function Sidebar() {
  const { data: sessions = [] } = useSessionsQuery();
  const activeId = useChatStore((s) => s.activeId);
  const createSession = useCreateSession();
  const deleteSession = useDeleteSession();
  const { startResume } = useStreamChat();
  const [search, setSearch] = useState("");

  const filtered = search
    ? sessions.filter((s) =>
        (s.title || "").toLowerCase().includes(search.toLowerCase()),
      )
    : sessions;

  const groups = groupSessionsByTime(filtered);

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
    <aside className="w-[320px] min-w-[320px] flex flex-col bg-sidebar">
      {/* Brand */}
      <div className="px-5 pt-5 pb-4 flex items-start gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-sidebar-primary grid place-items-center text-sidebar-primary-foreground flex-shrink-0 overflow-hidden">
          <IconRoute size={18} />
        </div>
        <div className="flex flex-col gap-0.5">
          <div className="text-[15px] font-bold text-sidebar-fg leading-normal">
            路书
          </div>
          <div className="text-[11px] text-sidebar-muted leading-normal">
            旅行规划助手
          </div>
        </div>
      </div>

      {/* New trip button */}
      <button
        className="mx-3 mb-3 px-3.5 py-2.5 bg-sidebar-primary text-sidebar-primary-foreground rounded-lg text-[13px] font-medium flex items-center gap-2 hover:opacity-90 transition-opacity w-[calc(100%-24px)] text-left h-[40px]"
        onClick={handleNewSession}
      >
        <IconPlus size={16} />
        开始新旅行
      </button>

      {/* Search */}
      <div className="mx-3 mb-3 relative">
        <IconSearch
          size={14}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sidebar-muted pointer-events-none"
        />
        <input
          type="text"
          placeholder="搜索历史对话..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full h-[36px] pl-8 pr-3 bg-sidebar-hover border border-transparent rounded-lg text-sidebar-fg text-[13px] outline-none placeholder:text-sidebar-muted focus:border-sidebar-primary focus:bg-sidebar-active transition-colors"
        />
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto py-2 sidebar-scroll">
        {filtered.length === 0 && (
          <div className="text-center text-[13px] text-sidebar-muted py-10">
            {search ? "未找到匹配会话" : "暂无会话"}
          </div>
        )}
        {groups.map((group, groupIdx) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <div
              className={
                "px-5 pb-1 " +
                (groupIdx === 0 ? "pt-2" : "pt-3")
              }
            >
              <span className="text-[11px] font-bold text-sidebar-muted">
                {group.label}
              </span>
            </div>
            {group.items.map((s) => {
              const active = s.id === activeId;
              const displayTitle = s.title || s.id.slice(0, 8) + "…";
              return (
                <div
                  key={s.id}
                  className={
                    "group flex items-start gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer transition-colors relative " +
                    (active ? "bg-sidebar-active" : "hover:bg-sidebar-hover")
                  }
                  onClick={() => switchSession(s.id)}
                >
                  <IconRoute
                    size={16}
                    className={
                      "mt-0.5 flex-shrink-0 " +
                      (active ? "text-sidebar-primary" : "text-sidebar-muted")
                    }
                  />
                  <div className="flex-1 min-w-0 pr-5">
                    <div
                      className="text-[13px] font-medium truncate leading-snug text-sidebar-fg"
                      title={displayTitle}
                    >
                      {displayTitle}
                    </div>
                    <div className="text-[11px] text-sidebar-muted truncate mt-0.5">
                      {s.lastMessage?.trim() || "暂无消息"}
                    </div>
                  </div>
                  <button
                    className="absolute top-2.5 right-3 w-5 h-5 inline-flex items-center justify-center rounded text-sidebar-muted opacity-0 group-hover:opacity-100 transition-all hover:bg-destructive hover:text-destructive-foreground text-xs"
                    onClick={(e) => handleDeleteSession(s.id, e)}
                    title="删除会话"
                    aria-label="删除会话"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* User footer */}
      <div className="px-3 py-3 border-t border-sidebar-border flex items-center gap-2.5 h-[64px]">
        <div className="w-8 h-8 rounded-2xl bg-sidebar-active grid place-items-center text-[13px] font-bold text-sidebar-fg flex-shrink-0">
          我
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className="text-[13px] font-medium text-sidebar-fg truncate">
            我
          </div>
          <div className="text-[11px] text-sidebar-muted truncate">
            探险者版 · 已规划 {sessions.length} 条路线
          </div>
        </div>
      </div>
    </aside>
  );
}
