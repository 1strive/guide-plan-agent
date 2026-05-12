import { useState, useRef, useEffect, useCallback } from "react";
import * as api from "./api";

type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ name: string; status: "running" | "done" }>;
  interrupt?: { id: string; message: string; reason: string; options?: string[] };
};

export default function App() {
  const [sessions, setSessions] = useState<api.SessionItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingInterrupt, setPendingInterrupt] = useState<{
    id: string;
    message: string;
    reason: string;
    options?: string[];
  } | null>(null);
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
    setPendingInterrupt(null);
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

  async function handleSend(resumeInterrupt?: { id: string; reason: string }) {
    const text = input.trim();
    if (!text || !activeId || sending) return;

    setInput("");
    setPendingInterrupt(null);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setSending(true);

    let assistantContent = "";
    const toolCalls: Array<{ name: string; status: "running" | "done" }> = [];
    let currentInterrupt:
      | { id: string; message: string; reason: string; options?: string[] }
      | undefined;

    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", toolCalls: [] },
    ]);

    try {
      const resume = resumeInterrupt
        ? [
            {
              interruptId: resumeInterrupt.id,
              status: "resolved" as const,
              payload: { answer: text },
            },
          ]
        : undefined;

      for await (const event of api.sendMessageStream(
        activeId!,
        text,
        resume,
      )) {
        switch (event.type) {
          case "TEXT_MESSAGE_CONTENT": {
            assistantContent += event.delta as string;
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = {
                role: "assistant",
                content: assistantContent,
                toolCalls: [...toolCalls],
              };
              return next;
            });
            break;
          }
          case "TOOL_CALL_START": {
            toolCalls.push({
              name: event.toolCallName as string,
              status: "running",
            });
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = {
                role: "assistant",
                content: assistantContent,
                toolCalls: [...toolCalls],
              };
              return next;
            });
            break;
          }
          case "TOOL_CALL_END": {
            const runningCall = toolCalls.find((t) => t.status === "running");
            if (runningCall) runningCall.status = "done";
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = {
                role: "assistant",
                content: assistantContent,
                toolCalls: [...toolCalls],
              };
              return next;
            });
            break;
          }
          case "RUN_FINISHED": {
            const outcome = event.outcome as
              | {
                  type: string;
                  interrupts?: Array<{
                    id: string;
                    message?: string;
                    reason: string;
                  }>;
                }
              | undefined;
            if (
              outcome?.type === "interrupt" &&
              outcome.interrupts &&
              outcome.interrupts.length > 0
            ) {
              const intItem = outcome.interrupts[0]!;
              const interruptOptions =
                (intItem as { metadata?: { options?: string[] } }).metadata
                  ?.options;
              currentInterrupt = {
                id: intItem.id,
                message: intItem.message ?? "",
                reason: intItem.reason,
                options: interruptOptions,
              };
              setPendingInterrupt(currentInterrupt);
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1]!;
                next[next.length - 1] = {
                  role: last.role,
                  content: currentInterrupt!.message,
                  toolCalls: last.toolCalls,
                  interrupt: currentInterrupt,
                };
                return next;
              });
            }
            break;
          }
          case "RUN_ERROR": {
            assistantContent += `\n[错误] ${event.message}`;
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = {
                role: "assistant",
                content: assistantContent,
                toolCalls: [...toolCalls],
              };
              return next;
            });
            break;
          }
        }
      }
      await refreshSessions();
    } catch (e) {
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          content: `[请求失败] ${(e as Error).message}`,
        };
        return next;
      });
    } finally {
      setSending(false);
    }
  }

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

  function handleOptionClick(option: string) {
    if (!pendingInterrupt || sending) return;
    setInput("");
    setPendingInterrupt(null);
    setMessages((prev) => [...prev, { role: "user", content: option }]);
    setSending(true);

    let assistantContent = "";
    const toolCalls: Array<{ name: string; status: "running" | "done" }> = [];
    let currentInterrupt:
      | { id: string; message: string; reason: string; options?: string[] }
      | undefined;

    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", toolCalls: [] },
    ]);

    const resume = [
      {
        interruptId: pendingInterrupt.id,
        status: "resolved" as const,
        payload: { answer: option },
      },
    ];

    (async () => {
      try {
        for await (const event of api.sendMessageStream(
          activeId!,
          option,
          resume,
        )) {
          switch (event.type) {
            case "TEXT_MESSAGE_CONTENT": {
              assistantContent += event.delta as string;
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = {
                  role: "assistant",
                  content: assistantContent,
                  toolCalls: [...toolCalls],
                };
                return next;
              });
              break;
            }
            case "TOOL_CALL_START": {
              toolCalls.push({
                name: event.toolCallName as string,
                status: "running",
              });
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = {
                  role: "assistant",
                  content: assistantContent,
                  toolCalls: [...toolCalls],
                };
                return next;
              });
              break;
            }
            case "TOOL_CALL_END": {
              const runningCall = toolCalls.find((t) => t.status === "running");
              if (runningCall) runningCall.status = "done";
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = {
                  role: "assistant",
                  content: assistantContent,
                  toolCalls: [...toolCalls],
                };
                return next;
              });
              break;
            }
            case "RUN_FINISHED": {
              const outcome = event.outcome as
                | {
                    type: string;
                    interrupts?: Array<{
                      id: string;
                      message?: string;
                      reason: string;
                      metadata?: { options?: string[] };
                    }>;
                  }
                | undefined;
              if (
                outcome?.type === "interrupt" &&
                outcome.interrupts &&
                outcome.interrupts.length > 0
              ) {
                const intItem = outcome.interrupts[0]!;
                currentInterrupt = {
                  id: intItem.id,
                  message: intItem.message ?? "",
                  reason: intItem.reason,
                  options: intItem.metadata?.options,
                };
                setPendingInterrupt(currentInterrupt);
                setMessages((prev) => {
                  const next = [...prev];
                  const last = next[next.length - 1]!;
                  next[next.length - 1] = {
                    role: last.role,
                    content: currentInterrupt!.message,
                    toolCalls: last.toolCalls,
                    interrupt: currentInterrupt,
                  };
                  return next;
                });
              }
              break;
            }
            case "RUN_ERROR": {
              assistantContent += `\n[错误] ${event.message}`;
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = {
                  role: "assistant",
                  content: assistantContent,
                  toolCalls: [...toolCalls],
                };
                return next;
              });
              break;
            }
          }
        }
        await refreshSessions();
      } catch (e) {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            content: `[请求失败] ${(e as Error).message}`,
          };
          return next;
        });
      } finally {
        setSending(false);
      }
    })();
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
            <div
              key={i}
              className={`message ${msg.role}${msg.interrupt ? " interrupt" : ""}`}
            >
              {msg.interrupt && (
                <div className="interrupt-badge">需要补充信息</div>
              )}
              <div className="message-content">{msg.content}</div>
              {msg.interrupt && msg.interrupt.options && msg.interrupt.options.length > 0 && (
                <div className="interrupt-options">
                  {msg.interrupt.options.map((opt, idx) => (
                    <button
                      key={idx}
                      className="option-btn"
                      disabled={sending}
                      onClick={() => handleOptionClick(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="tool-calls">
                  {msg.toolCalls.map((tc, j) => (
                    <span key={j} className={`tool-tag ${tc.status}`}>
                      {tc.status === "running" ? "⏳" : "✅"} {tc.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {sending &&
            !messages.some(
              (m, idx) =>
                m.role === "assistant" &&
                idx === messages.length - 1 &&
                m.toolCalls &&
                m.toolCalls.length > 0,
            ) && <div className="message assistant loading">思考中…</div>}
          <div ref={chatEndRef} />
        </div>

        <div className="input-row">
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
          />
          <button
            onClick={() => {
              if (pendingInterrupt) {
                handleSend({
                  id: pendingInterrupt.id,
                  reason: pendingInterrupt.reason,
                });
              } else {
                handleSend();
              }
            }}
            disabled={!activeId || sending}
          >
            发送
          </button>
        </div>
      </main>
    </div>
  );
}
