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

  // Task 整合-2:streamCtrlRef abort 后**仅前端断开 SSE**,后端 Run 继续跑 + 持续写库;
  // 主动停止需调 cancelRun(走「停止」按钮)
  const streamCtrlRef = useRef<AbortController | null>(null);
  // Task 整合-2:当前 Run 的 runId,从 RUN_STARTED 事件拿;给「停止」按钮 / 续订用
  const currentRunIdRef = useRef<string | null>(null);

  function abortInFlight() {
    if (streamCtrlRef.current) {
      streamCtrlRef.current.abort();
      streamCtrlRef.current = null;
    }
    currentRunIdRef.current = null;
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

  /**
   * Task 整合-2 切换会话流程:
   * 1. abort 旧 SSE(后端 Run 继续在跑)
   * 2. 加载历史 messages + status
   * 3. status='running' → getActiveRun 拿 runId → 启动续订(从 seq=0 完整回放)
   *    续订时把"已加载历史里的最后一条 assistant"剔除(因为续订会重建它)
   * 4. 续订完成 = Run 结束 → sending 自动转 false
   */
  async function switchSession(id: string) {
    abortInFlight();
    setSending(false);
    setActiveId(id);
    setMessages([]);
    setPendingInterrupt(null);

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

    // 整合-2:running 会话需要续订;此时剔除最后一条 assistant(回放会重建它)
    if (status === "running") {
      try {
        const { active } = await api.getActiveRun(id);
        if (active && active.status !== "completed" && active.status !== "cancelled" && active.status !== "failed") {
          // 剔除最后一条 assistant,等续订事件回放重建
          const lastMsg = initialMessages[initialMessages.length - 1];
          if (lastMsg && lastMsg.role === "assistant") {
            initialMessages = initialMessages.slice(0, -1);
          }
          setMessages(initialMessages);
          // 启动续订,从 0 开始完整回放
          void startResume(id, active.runId);
          return;
        }
      } catch {
        // active 接口失败不阻断,继续走静态加载
      }
    }

    setMessages(initialMessages);
  }

  /** 启动续订(GET /runs/:runId/stream?after_seq=0)→ 走跟 handleSend 一样的事件循环 */
  async function startResume(sessionId: string, runId: string) {
    const ctl = new AbortController();
    streamCtrlRef.current = ctl;
    currentRunIdRef.current = runId;
    setSending(true);
    // 续订时不预先加 placeholder assistant — 事件回放里有 RUN_STARTED 等,
    // 第一个 TEXT_MESSAGE_CONTENT 来时我们在 consumeStream 里 lazy 加
    try {
      const stream = api.resumeRunStream(sessionId, runId, 0, ctl.signal);
      await consumeStream(stream, ctl, /* hasPreAssistantStub */ false);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("resume failed:", e);
      }
    }
  }

  async function handleDeleteSession(id: string, e: React.MouseEvent) {
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

  /**
   * Task 整合-2:主动停止当前 Run
   * 调 cancelRun(后端推进 cancelling → cancelled),前端 abort SSE
   */
  async function handleStop() {
    const runId = currentRunIdRef.current;
    if (!runId || !activeId) return;
    try {
      await api.cancelRun(activeId, runId);
    } catch (e) {
      console.error("cancelRun failed:", e);
    }
    abortInFlight();
    setSending(false);
  }

  async function handleSend(resumeInterrupt?: { id: string; reason: string }) {
    const text = input.trim();
    if (!text || !activeId || sending) return;

    setInput("");
    setPendingInterrupt(null);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "", toolCalls: [] },
    ]);
    setSending(true);

    const ctl = new AbortController();
    streamCtrlRef.current = ctl;
    currentRunIdRef.current = null;

    const resume = resumeInterrupt
      ? [
          {
            interruptId: resumeInterrupt.id,
            status: "resolved" as const,
            payload: { answer: text },
          },
        ]
      : undefined;

    const stream = api.sendMessageStream(activeId!, text, resume, ctl.signal);
    await consumeStream(stream, ctl, /* hasPreAssistantStub */ true);
  }

  function handleOptionClick(option: string) {
    if (!pendingInterrupt || sending) return;
    setInput("");
    const resumeInterrupt = {
      id: pendingInterrupt.id,
      reason: pendingInterrupt.reason,
    };
    setPendingInterrupt(null);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: option },
      { role: "assistant", content: "", toolCalls: [] },
    ]);
    setSending(true);

    const ctl = new AbortController();
    streamCtrlRef.current = ctl;
    currentRunIdRef.current = null;

    const stream = api.sendMessageStream(
      activeId!,
      option,
      [
        {
          interruptId: resumeInterrupt.id,
          status: "resolved" as const,
          payload: { answer: option },
        },
      ],
      ctl.signal,
    );
    void consumeStream(stream, ctl, /* hasPreAssistantStub */ true);
  }

  /**
   * 公共事件循环:被 handleSend / handleOptionClick / startResume(续订)复用
   * hasPreAssistantStub:调用方是否已经 push 了 placeholder assistant 占位
   *   - true:handleSend/Option 走的就绪路径(下一个 TEXT_MESSAGE_CONTENT 直接 append 到末尾)
   *   - false:续订路径(messages 里没占位,第一个 TEXT 来时 lazy 加)
   */
  async function consumeStream(
    stream: AsyncGenerator<api.AgUiEvent>,
    ctl: AbortController,
    hasPreAssistantStub: boolean,
  ) {
    let assistantContent = "";
    const toolCalls: Array<{ name: string; status: "running" | "done" }> = [];
    let currentInterrupt:
      | { id: string; message: string; reason: string; options?: string[] }
      | undefined;
    let assistantStubAdded = hasPreAssistantStub;

    const ensureAssistantStub = () => {
      if (!assistantStubAdded) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "", toolCalls: [] },
        ]);
        assistantStubAdded = true;
      }
    };

    const updateLastAssistant = () => {
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          content: assistantContent,
          toolCalls: [...toolCalls],
        };
        return next;
      });
    };

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "RUN_STARTED": {
            // 整合-2:拿到 runId 存 ref(给「停止」按钮用)
            currentRunIdRef.current = event.runId as string;
            break;
          }
          case "TEXT_MESSAGE_CONTENT": {
            ensureAssistantStub();
            assistantContent += event.delta as string;
            updateLastAssistant();
            break;
          }
          case "TOOL_CALL_START": {
            ensureAssistantStub();
            toolCalls.push({
              name: event.toolCallName as string,
              status: "running",
            });
            updateLastAssistant();
            break;
          }
          case "TOOL_CALL_END": {
            const runningCall = toolCalls.find((t) => t.status === "running");
            if (runningCall) runningCall.status = "done";
            updateLastAssistant();
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
              ensureAssistantStub();
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
            ensureAssistantStub();
            assistantContent += `\n[错误] ${event.message}`;
            updateLastAssistant();
            break;
          }
        }
      }
      await refreshSessions();
    } catch (e) {
      // AbortError 走切换 / 删除 / 主动停止路径,不算异常
      if ((e as Error).name !== "AbortError") {
        ensureAssistantStub();
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
      currentRunIdRef.current = null;
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
          {/* Task 整合-2:主动停止按钮(只在 sending + 有 runId 时显示) */}
          {sending && currentRunIdRef.current && (
            <button onClick={handleStop} className="btn-stop" title="主动停止当前 Run">
              停止
            </button>
          )}
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
