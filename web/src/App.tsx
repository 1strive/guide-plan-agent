import { useState, useRef, useEffect, useCallback } from "react";
import * as api from "./api";

type ChatMsg = {
  role: "user" | "assistant";
  content: string;
};

export default function App() {
  const [sessions, setSessions] = useState<api.SessionItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const refreshSessions = useCallback(async () => {
    const data = await api.listSessions();
    setSessions(data.sessions);
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleNewSession() {
    const data = await api.createSession();
    const newId = data.sessionId;
    await refreshSessions();
    await switchSession(newId);
  }

  async function switchSession(id: string) {
    setActiveId(id);
    setMessages([]);
    try {
      const data = await api.getSessionMessages(id);
      const loaded: ChatMsg[] = data.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
      setMessages(loaded);
    } catch {
      setMessages([]);
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || !activeId || sending) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setSending(true);

    try {
      const data = await api.sendMessage(activeId, text);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply },
      ]);
      // refresh sidebar title (auto-title on first msg)
      await refreshSessions();
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `[请求失败] ${(e as Error).message}` },
      ]);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const activeSession = sessions.find((s) => s.id === activeId);

  return (
    <div className="app">
      {/* 左侧边栏 */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>会话历史</h2>
          <button className="btn-new" onClick={handleNewSession}>
            + 新会话
          </button>
        </div>
        <ul className="session-list">
          {sessions.length === 0 && <li className="session-empty">暂无会话</li>}
          {sessions.map((s) => (
            <li
              key={s.id}
              className={`session-item ${s.id === activeId ? "active" : ""}`}
              onClick={() => switchSession(s.id)}
            >
              <span className="session-title">
                {s.title || s.id.slice(0, 8) + "…"}
              </span>
              <span className="session-time">
                {new Date(s.createdAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      </aside>

      {/* 右侧聊天区 */}
      <main className="chat-area">
        <header className="chat-header">
          <h1>Guide-Plan 旅游助手</h1>
          {activeSession && (
            <span className="chat-session-tag">
              {activeSession.title || activeSession.id.slice(0, 8) + "…"}
            </span>
          )}
        </header>

        <div className="chat-box">
          {messages.length === 0 && (
            <div className="placeholder">
              {activeId ? "输入消息开始聊天" : "点击左侧「+ 新会话」开始"}
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`message ${msg.role}`}>
              {msg.content}
            </div>
          ))}
          {sending && <div className="message assistant loading">思考中…</div>}
          <div ref={chatEndRef} />
        </div>

        <div className="input-row">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={activeId ? "输入消息…" : "请先创建会话"}
            disabled={!activeId || sending}
          />
          <button onClick={handleSend} disabled={!activeId || sending}>
            发送
          </button>
        </div>
      </main>
    </div>
  );
}
