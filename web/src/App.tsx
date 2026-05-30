import { useState, useRef, useEffect, useCallback } from "react";
import * as api from "./api";

type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ name: string; status: "running" | "done" }>;
  interrupt?: {
    id: string;
    message: string;
    reason: string;
    options?: string[];
  };
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
  // 八股 08-工程化实践.md §1 容错:Chat App 阶段的"客户端断开 = 整链终止"。
  // 切换 / 新建 / 删除当前会话时 abort 正在跑的 fetch,后端 req.raw 'close' 钩子接着 abort agent run。
  // Task 4.5 重构为 Run-as-Resource 后,这个 ref 会被「显式停止按钮 + 切走仅 unsubscribe」取代。
  const streamCtrlRef = useRef<AbortController | null>(null);

  function abortInFlight() {
    if (streamCtrlRef.current) {
      streamCtrlRef.current.abort();
      streamCtrlRef.current = null;
    }
  }

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
    abortInFlight();
    setSending(false);
    const data = await api.createSession();
    const newId = data.sessionId;
    await refreshSessions();
    await switchSession(newId);
  }

  async function switchSession(id: string) {
    abortInFlight();
    setSending(false);
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

  async function handleDeleteSession(id: string, e: React.MouseEvent) {
    // 关键:阻止冒泡到 li 的 onClick(否则会先触发 switchSession)
    e.stopPropagation();
    const session = sessions.find((s) => s.id === id);
    const title = session?.title || id.slice(0, 8) + "…";
    if (!confirm(`确定要删除会话「${title}」吗?该操作不可恢复。`)) return;

    if (id === activeId) {
      abortInFlight();
      setActiveId(null);
      setMessages([]);
      setPendingInterrupt(null);
      setSending(false);
    }
    await api.deleteSession(id);
    await refreshSessions();
  }

  async function handleSend(resumeInterrupt?: { id: string; reason: string }) {
    const text = input.trim();
    if (!text || !activeId || sending) return;

    setInput("");
    setPendingInterrupt(null);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setSending(true);

    // 八股 08 §1:为本次请求建独立 AbortController,登记到 ref 供切换/删除时停掉
    const ctl = new AbortController();
    streamCtrlRef.current = ctl;

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
        ctl.signal,
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
              const interruptOptions = (
                intItem as { metadata?: { options?: string[] } }
              ).metadata?.options;
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
      // 用户切换/删除会话主动 abort 走这里,不算错误,直接吞掉
      if ((e as Error).name !== "AbortError") {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            content: `[请求失败] ${(e as Error).message}`,
          };
          return next;
        });
      }
    } finally {
      if (streamCtrlRef.current === ctl) streamCtrlRef.current = null;
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

    // 同 handleSend:独立 AbortController 注册到 ref,切走时可断流
    const ctl = new AbortController();
    streamCtrlRef.current = ctl;

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
          ctl.signal,
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
        if ((e as Error).name !== "AbortError") {
          setMessages((prev) => {
            const next = [...prev];
            next[next.length - 1] = {
              role: "assistant",
              content: `[请求失败] ${(e as Error).message}`,
            };
            return next;
          });
        }
      } finally {
        if (streamCtrlRef.current === ctl) streamCtrlRef.current = null;
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
              <span className="session-meta">
                {s.totalTokens > 0 && (
                  <span className="session-tokens">
                    {s.totalTokens.toLocaleString()} tokens
                  </span>
                )}
                <span className="session-time">
                  {new Date(s.createdAt).toLocaleDateString()}
                </span>
              </span>
              <button
                className="session-delete"
                onClick={(e) => handleDeleteSession(s.id, e)}
                title="删除会话"
                aria-label="删除会话"
              >
                ×
              </button>
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
              {msg.interrupt &&
                msg.interrupt.options &&
                msg.interrupt.options.length > 0 && (
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
