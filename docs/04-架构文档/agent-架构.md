# Agent 服务架构与运转流程

> **文档目的**:把后端 agent 服务从「HTTP 入口 → ReAct 主循环 → 工具调用 → 流式输出」整条链路用一份文档讲清楚。任何人(包括 Claude)接手开发前都应先读此文档,而不是去逆向 `src/index.ts`。
>
> **本文档是活文档**——核心模块改动后必须回到 §7「维护清单」核对相关章节是否要同步更新。
>
> **当前对齐的开发阶段**:阶段2 已完成(Prompt 版本化 + Few-shot/CoT + 评测框架 + 注入防御),阶段3 RAG 未开始。
>
> **最近更新**:2026-05-30(加入 Prompt 注入防御:`sanitize.ts` + `securityRules` + handler 入口/出口检测,实测 5/5 防御成功)

---

## 0. 文档约定

- **是什么**:运行时的「数据流 + 控制流」全景,加关键工程决策的"为什么"。
- **不是什么**:① 不是 README(不讲怎么安装);② 不是 API 参考(每个字段都讲会过厚);③ 不替代源码注释。
- **引用规则**:代码引用一律带 `path:line`,便于 grep 跳转;Task 引用对应 `docs/开发规划.md`;八股引用对应 `docs/01-面试八股文/`。

---

## 1. 系统全貌

### 1.1 组件分层

```
┌──────────────────────────────────────────────────────────────────┐
│                          Web (web/src/)                          │
│  App.tsx ──HTTP/SSE──> api.ts ──fetch──> 后端                    │
└──────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     HTTP 层 (src/index.ts)                       │
│  Fastify routes:                                                 │
│    GET    /health                                                │
│    GET    /sessions             ── 列出全部会话                  │
│    POST   /sessions             ── 创建空会话                    │
│    GET    /sessions/:id/messages── 取历史消息                    │
│    DELETE /sessions/:id         ── 删除会话(FK 级联清消息)     │
│    POST   /sessions/:id/stream  ── ★ 流式对话主入口             │
└──────────────────────────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
┌──────────────┐         ┌────────────────┐       ┌────────────────┐
│  Prompts     │         │   Agent 核心   │       │   Tools 层     │
│  (prompts/)  │         │   (llm.ts)     │       │  (tools.ts)    │
│              │         │                │       │                │
│ v1_base.ts   │ system  │ runAgentStream │ tool  │ search_dest.   │
│ v2_cot.ts    │────────>│  ReAct 多轮    │──────>│ get_dest_detail│
│ render.ts    │         │  AbortSignal   │       │                │
│ index.ts     │         │  Token 累加    │       └────────┬───────┘
│ (注册表)     │         │  AG-UI 事件流  │                │
└──────────────┘         └────────┬───────┘                │
                                  │                        │
                                  ▼                        ▼
                         ┌────────────────┐       ┌────────────────┐
                         │  LLM Provider  │       │   MySQL Pool   │
                         │  postChatStream│       │  (db/pool.ts)  │
                         │  SSE 解析      │       │                │
                         │  超时控制      │       │  chat_sessions │
                         └────────────────┘       │  chat_messages │
                                                  │  destinations  │
                                                  │  destination_  │
                                                  │   features     │
                                                  └────────────────┘
```

### 1.2 模块职责表

| 模块 | 文件 | 职责 | 不该做什么 |
|------|------|------|----------|
| HTTP 层 | `src/index.ts` | 路由、SSE 生命周期、abort 钩子、日志 trace_id、token 持久化 | 不写 LLM 调用细节、不解析 SSE 协议 |
| Prompts | `src/agent/prompts/` | section 化模板、版本注册、渲染插值、Few-shot prepend | 不知道 LLM 怎么调、不接 DB |
| Agent 核心 | `src/agent/llm.ts` | postChatStream(LLM SSE 解析)、runAgentStream(ReAct 主循环)、`[ASK_USER]` 检测、Token 统计 | 不写 DB、不接前端 |
| Tools | `src/agent/tools.ts` | function calling 定义、工具实现、参数 zod 校验 | 不发 SSE 事件、不调 LLM |
| AG-UI 协议 | `src/agent/ag-ui.ts` | 事件类型枚举 + 构造器(RUN_STARTED / TEXT_MESSAGE_* / TOOL_CALL_* / RUN_FINISHED) | 不含业务逻辑 |
| Sanitize 安全 | `src/agent/sanitize.ts` | `detectInjection` 入口注入检测 / `wrapUntrusted` 边界标记 / `detectSystemLeak` 出口泄露检测(纯函数) | 不发日志、不修改输入,只返回判定结果 |
| Token Usage | `src/agent/token-usage.ts` | `estimateTokens` 兜底估算、`accumulateUsage` 累加 | 不写 DB |
| Chat 持久化 | `src/db/chatRepo.ts` | chat_sessions / chat_messages 的 CRUD | 不知道 LLM、不调工具 |
| Destination 数据 | `src/db/destinationRepo.ts` | destinations / destination_features 的查询 | 不写 chat 表 |
| Config | `src/config.ts` | 环境变量 zod schema + 加载 | 不依赖业务模块 |
| Eval | `src/eval/`、`scripts/eval-prompt.ts` | Prompt 评测器 + 测试集 + 批量脚本(Task 2.3) | 不污染生产 chat 表 |

---

## 2. HTTP API 一览

| Method | Path | 请求体 / 参数 | 响应 | 代码位置 |
|--------|------|-------------|------|---------|
| GET | `/health` | — | `{ ok, db }`,503 表示 DB 挂 | `src/index.ts:40-48` |
| GET | `/sessions` | — | `{ sessions: SessionRow[] }` | `src/index.ts:50-53` |
| POST | `/sessions` | — | `201 { sessionId }` | `src/index.ts:68-73` |
| GET | `/sessions/:id/messages` | `id` | `{ messages: { role, content }[] }`,404 表示不存在 | `src/index.ts:55-66` |
| DELETE | `/sessions/:id` | `id` | `204 null`(成功)/`404`(不存在) | `src/index.ts:83-95` |
| POST | `/sessions/:id/stream` | `{ message, threadId?, runId?, resume?, promptVersion? }` | SSE 流(`data: {AGUIEvent}\n\n`),`X-Trace-Id` 头携带 runId | `src/index.ts:113-235` |

---

## 3. 核心运转流程

### 3.1 创建会话(POST /sessions)

```
client                      handler                  DB
  │  POST /sessions            │                      │
  │ ─────────────────────────► │                      │
  │                            │ randomUUID()         │
  │                            │ createSession(id)    │
  │                            │ ────────────────────►│ INSERT chat_sessions
  │                            │ ◄────────────────────│
  │  201 { sessionId }         │                      │
  │ ◄───────────────────────── │                      │
```

**约束**:此时 `chat_sessions.title` 为 NULL、`total_tokens=0`、`status=running`(若有此列)。第一次对话结束时由 stream handler 把 user message 前 30 字写入 title(`src/index.ts:195-199`)。

### 3.2 发起对话(POST /sessions/:id/stream)★ 核心场景

这是整个 agent 服务最复杂、调用面最广的流程。下图是**全链路**:

```mermaid
sequenceDiagram
    autonumber
    participant U as 客户端
    participant H as HTTP Handler<br/>(src/index.ts)
    participant DB as MySQL
    participant P as Prompts
    participant A as runAgentStream<br/>(llm.ts)
    participant L as LLM Provider
    participant T as Tools

    U->>H: POST /sessions/:id/stream<br/>{message, promptVersion?}
    H->>H: detectInjection(message)<br/>(八股 09 §8.3 #1 输入清洗)
    Note over H: 命中 → reqLog.warn,继续走流程<br/>未命中 → 走原路径
    H->>DB: sessionExists(id)
    DB-->>H: ✓
    H->>DB: insertMessage(user, message)<br/>(存原始,不存包裹版)
    H->>DB: listRecentMessages(CHAT_HISTORY_LIMIT)
    H->>P: getPrompt(promptVersion ?? config)
    P-->>H: { system, prependMessages }
    H->>H: 拼 msgs = [system, ...Few-shot, ...history]
    Note over H: 注入命中 → 把最后一条 user 包裹为<br/><untrusted_user_content>...</untrusted_user_content>
    H->>U: reply.hijack() + writeHead(200, SSE)

    Note over H: 启动 15s 心跳 + req.raw 'close' 钩子<br/>+ AbortController + onUsage 回调

    H->>A: runAgentStream(pool, config, msgs, ...)
    A-->>H: RUN_STARTED
    H-->>U: data: {RUN_STARTED}\n\n

    loop ReAct 多轮(最多 LLM_MAX_TOOL_ROUNDS)
        A->>L: POST /chat/completions (stream=true)
        L-->>A: SSE chunks (delta.content / delta.tool_calls)
        A-->>H: TEXT_MESSAGE_START → CONTENT* → END
        H-->>U: data: {events}
        A->>A: 收集 tool_calls / fullContent

        opt 有 tool_calls
            A->>T: runTool(name, args)
            T->>DB: SELECT destinations / features
            DB-->>T: rows
            T-->>A: { text, referencedDestinationIds }
            A-->>H: TOOL_CALL_START → ARGS → END → RESULT
            H-->>U: data: {events}
            A->>A: append tool result 到 msgs,下一轮
        end
    end

    A->>A: parseAskUser(fullContent)
    alt 含 [ASK_USER]
        A-->>H: RUN_FINISHED { outcome: interrupt }
    else 正常
        A-->>H: RUN_FINISHED { outcome: success }
    end
    H-->>U: data: {RUN_FINISHED}\n\n

    Note over H: 流结束 → finally 清理:<br/>clearInterval(heartbeat)<br/>req.raw.off('close')

    H->>H: detectSystemLeak(finalText, prompt.system)<br/>(八股 09 §8.3 #5 输出过滤)
    Note over H: 命中 → reqLog.warn,不修改输出

    alt !ctl.signal.aborted
        H->>DB: insertMessage(assistant, fullContent or interrupt)
        H->>DB: updateSessionTitle(若首条) / updateSessionTokens
    end

    H->>U: reply.raw.end()
    H->>H: reqLog.info('agent run summary')
```

#### 3.2.1 详细步骤说明

1. **入参与会话校验**(`src/index.ts:115-133`):取 body 中的 message / promptVersion / resume,验证 session 存在
2. **持久化 user 消息**(`:138`):立刻写库,即使后续 LLM 失败也保留用户输入
3. **拼 messages**(`:141-158`):
   ```
   [{ role: 'system', content: prompt.system }]
     + prompt.prependMessages (Few-shot 3 条)
     + history (按 CHAT_HISTORY_LIMIT=30 反向取最近)
   ```
4. **接管 SSE socket**(`:161-168`):`reply.hijack()` 让 Fastify 不再管收尾,headers 写完即可流式吐内容
5. **三层保护**:
   - **AbortController**(`:171-178`):`req.raw 'close'` 事件 → `ctl.abort()` → 下游 `fetch` 立刻停
   - **心跳**(`:181-183`):15s 一次 `: ping\n\n` 注释行,防反向代理按 idle 断连
   - **onUsage 回调**(`:188-196`):每轮 LLM 结束累加 `prompt/completion/total tokens`
6. **ReAct 主循环**(`runAgentStream`,`src/agent/llm.ts:222-435`):见 §3.2.2
7. **流结束**(`:189-206`):
   - 仅在 **未 abort** 时才入库 assistant 消息(避免污染历史)
   - 首条用户消息会自动生成 title(前 30 字)
   - `updateSessionTokens` 累加 token 到 `chat_sessions.total_tokens`
8. **关 SSE**(`:224`):`reply.raw.end()`

#### 3.2.2 ReAct 主循环细节(`runAgentStream`)

```
for round in 0..LLM_MAX_TOOL_ROUNDS:           # 默认 10
  if signal.aborted: break

  stream = postChatStream(LLM, msgs, signal)   # OpenAI 兼容 /chat/completions

  for chunk in stream:
    if chunk.usage:                            # 最后一 chunk 带 usage
      lastUsage = ...
    if delta.content:
      yield TEXT_MESSAGE_START / CONTENT       # 首次 content 时发 START
    if delta.tool_calls:
      yield TOOL_CALL_START / ARGS             # 流式收集 args
    if finish_reason in ['stop', 'tool_calls']:
      yield TEXT_MESSAGE_END / TOOL_CALL_END

  totalUsage += lastUsage ?? estimateFromText()
  onUsage(roundUsage, round)                   # 回调到 HTTP 层打日志

  if collected tool_calls:
    msgs.append({ role: assistant, tool_calls })
    for tc in tool_calls:
      result = runTool(tc.name, tc.args)
      yield TOOL_CALL_RESULT
      msgs.append({ role: tool, tool_call_id, content })
    continue  # 下一轮 LLM,带着工具结果重新生成

  # 无工具调用 → 检查是否反问
  if parseAskUser(fullContent).isAskUser:
    yield RUN_FINISHED { outcome: interrupt }
    return

  break  # 正常文本回答,结束循环

yield RUN_FINISHED { outcome: success, usage: totalUsage }
```

**关键不变量**:
- 工具调用结果必须以 `role:tool` + `tool_call_id` 形式追加到 msgs,LLM 下一轮才能"看见"
- `[ASK_USER]` 协议是当前的"反问"实现(临时方案,见 §5.4)
- usage 必须显式声明 `stream_options.include_usage`,否则流式不返回 usage(`postChatStream` 已处理)

### 3.3 中断处理(客户端断开)

当前实现是**阶段1 的 Chat App 心智**:客户端断开 = 整个 Run 终止。

```
client                handler              llm/tools
  │ (关闭页面/切走)      │                      │
  │ ─────[FIN]────────► │                      │
  │                     │ req.raw 'close'      │
  │                     │ → ctl.abort()        │
  │                     │ ────────────────────►│ AbortSignal 触发
  │                     │                      │ fetch 立即终止
  │                     │ ◄────────────────────│
  │                     │ finally:             │
  │                     │   clearInterval      │
  │                     │   reply.raw.end()    │
  │                     │ ⚠️ assistant 消息    │
  │                     │ 不入库               │
```

**为什么 abort 不入库**:`src/index.ts:189` 的 `if (!ctl.signal.aborted)` 保护——中途断开时 LLM 输出可能不完整,存进去会污染下次的 history。

**已知局限**:此设计让"切走会话" = "丢失任务",阶段4 Task 4.5 会把它改造为「切走 = unsubscribe but Run continues」+ event 回放续流。详见 §6。

### 3.4 历史查询(GET /sessions/:id/messages)

最简单的 CRUD:`getSessionMessages` 按 `created_at ASC` 全量返回该会话的 user/assistant/system 三种角色消息(`src/db/chatRepo.ts:56-65`)。

**当前没有的字段**(阶段4 Task 4.5 会加):
- `status: 'running' | 'end'`(标识 Run 是否还在跑)
- `lastMessage` 用于断点续传

### 3.5 删除会话(DELETE /sessions/:id)

```
client                handler                DB
  │ DELETE /sessions/:id │                    │
  │ ──────────────────► │                    │
  │                     │ sessionExists()    │
  │                     │ ──────────────────►│
  │                     │ ◄──────────────────│
  │                     │ deleteSession()    │
  │                     │ ──────────────────►│ DELETE chat_sessions
  │                     │                    │ FK CASCADE → chat_messages
  │                     │ ◄──────────────────│
  │ 204 No Content      │                    │
  │ ◄────────────────── │                    │
```

**前端配合**(`web/src/App.tsx:97`):删除当前激活会话前,前端自己 abort 正在跑的 SSE 连接 → 触发 §3.3 流程,后端把 Run 也停掉。后端因此不需要专门"终止 in-flight stream"的逻辑(阶段4 Task 4.5 改造后需要联动 `runManager.cancel(runId)`)。

---

## 4. 数据流细节

### 4.1 messages 拼接顺序(Task 2.1 后)

```
index = 0   │ system           │ getPrompt(version).system
            │                  │   ├─ role
            │                  │   ├─ taskScope(含示例防污染说明)
            │                  │   ├─ toolUsageRules (1~4)
            │                  │   ├─ outputFormat
            │                  │   ├─ contextRules
            │                  │   ├─ clarificationRules ([ASK_USER] 协议)
            │                  │   ├─ securityRules (Prompt 注入防御指令,八股 09 §8)
            │                  │   └─ cotInstruction(仅 v2_cot)
index 1~N   │ Few-shot prepend │ prompt.prependMessages(3 条 user+assistant 交错)
index N+1~  │ history          │ listRecentMessages(最近 30 条,正序)
            │                  │   └─ 当前 user 消息(insertMessage 已写库,在 history 末)
            │                  │      ⚠ 若 detectInjection 命中,该条会被 wrapUntrusted 包裹
            │                  │        为 <untrusted_user_content>...</untrusted_user_content>
```

**为什么 user 消息在 history 末**:`src/index.ts:138` 先 `insertMessage(user, message)` 再 `listRecentMessages`,所以 history 的最后一条就是当前用户输入,无需单独 append。

**为什么只包裹"当前 user 消息"而不包裹历史**:历史里的旧攻击假定已在当时被防御过(模型已拒绝,fullContent 落库的是拒绝回复)。包裹历史会增加 token、且对已被防御的攻击无意义。

### 4.2 AG-UI 事件流(发给前端的 SSE)

事件类型定义在 `src/agent/ag-ui.ts:6-22`。一次成功对话的事件时序:

```
RUN_STARTED
  → STEP_STARTED(generating)
  →   TEXT_MESSAGE_START
  →   TEXT_MESSAGE_CONTENT × N
  →   TEXT_MESSAGE_END
  → STEP_FINISHED(generating)

[若有工具调用]
  → STEP_STARTED(tool_call)
  →   TOOL_CALL_START
  →   TOOL_CALL_ARGS × M
  →   TOOL_CALL_END
  → STEP_FINISHED(tool_call)
  → STEP_STARTED(tool_execution)
  →   TOOL_CALL_RESULT
  → STEP_FINISHED(tool_execution)
[回到 LLM 下一轮]

RUN_FINISHED { outcome, usage }
```

**前端解析**(`web/src/api.ts:65-80`):按行拆 SSE,识别 `data: ` 前缀,JSON.parse 后 yield;`App.tsx:99-200` switch 事件类型更新 UI。

### 4.3 Token 统计与计费链路

```
postChatStream 发送时显式带:
  stream_options: { include_usage: true }
                         │
                         ▼
最后一个 chunk 携带 usage { prompt_tokens, completion_tokens, total_tokens }
                         │
                         ▼
llm.ts runAgentStream:
  lastUsage = { promptTokens, completionTokens, totalTokens }  // snake → camel
  totalUsage = accumulateUsage(totalUsage, lastUsage)
  options.onUsage(roundUsage, round)  ────────┐
                         │                    │ 回调
                         ▼                    ▼
RUN_FINISHED { usage: totalUsage }    index.ts onUsage:
                         │              totalUsage += u
                         ▼              reqLog.info({ round, usage }, ...)
前端 sessionItem.totalTokens
(updateSessionTokens 落库后下次 GET /sessions 返回)
                         │
                         ▼
日志:agent run summary { usage, cost_usd, duration_ms }
       cost = (prompt/1000 × INPUT_PRICE) + (completion/1000 × OUTPUT_PRICE)
```

**Fallback 估算**:若 LLM 不返回 usage(部分 MiniMax 兼容协议),`runAgentStream` 用 `estimateTokens(text.length / 2)` 兜底——精度差但能保住成本审计链路。

---

## 5. 关键工程决策

### 5.1 为什么 `reply.hijack()` 而不是 Fastify 默认响应

Fastify 默认会等 handler return 后才 flush response。SSE 需要"边写边发",所以 `reply.hijack()` 把底层 socket 交给我们,自己管 `writeHead` / `write` / `end`。

**代价**:必须自己处理所有错误路径(否则 socket 泄漏),所以有 `try/finally` 包整段。

### 5.2 为什么显式声明 `stream_options.include_usage`

OpenAI 兼容协议默认**流式响应不返回 usage**。不声明就拿不到精确 token,只能用 `estimateTokens` 估算。Task 1.2 的成本审计依赖 usage,所以必须显式开。

### 5.3 为什么 Few-shot 用 messages 数组 prepend(而不是 system 内文本)

八股 09 §3.5 推荐:模型预训练时见到的 user/assistant 交错格式最熟悉,理解最稳。

**踩过的坑**:messages 形式有"模型把示例当真实历史"的污染风险——见 `docs/02-实验记录/exp-02-prompt-versions.md` 第 1 轮。修复方案:`v1_base.taskScope` 加边界声明(已落地)。

### 5.4 为什么 `[ASK_USER]` 用字符串协议(临时方案)

当前反问检测靠 `parseAskUser(fullContent)` 解析模型输出的 `[ASK_USER]` 前缀字符串(`src/agent/llm.ts:171-198`)。

**为什么不用 LangGraph 的 `interrupt()` 或更严谨的 function calling**:学习项目要把"流程拼起来"先跑通,字符串协议是最低成本。**Task 4.5 会重构**为 Run-as-Resource 模型 + 显式 interrupt 事件 + Checkpoint。

### 5.5 为什么 abort 时不入库 assistant 消息

中途断开时 LLM 输出截断,可能是 `"我推荐云南的..."` 这种不完整句子。存进去后下次对话作为 history 喂给 LLM,会严重污染上下文。所以 `src/index.ts:189` 用 `if (!ctl.signal.aborted)` 保护。

**已知缺陷**:用户切走会话再回来,assistant 输出丢失。阶段4 Task 4.5 会改造,见 §6。

### 5.6 为什么注入命中后不直接拒绝请求

`detectInjection` 命中后,handler 只做两件事:① 记日志告警;② 把消息用 `<untrusted_user_content>` 包裹后**继续走 LLM**。**不直接 return 403**。

理由:
1. **规则匹配有误杀**:用户真说"我想去看 system update 风格的建筑设计"会命中 `pseudo_section_delimiter` 规则——直接拒绝会让正常用户莫名其妙
2. **双层防御更鲁棒**:`securityRules` 已经训练模型识别注入并自己拒绝,sanitize 只是"加一层提醒",让模型在更明确的边界下做最终判断
3. **可观测优先**:阶段当前是项目早期,先把"注入流量分布"通过 `prompt injection detected` 告警收集起来,后期决定是否升级为硬拦截
4. **实测验证**:`docs/02-实验记录/exp-02-prompt-versions-2026-05-30T10-37-46-151Z.json` 的 5 条 inj-* case 全部通过,说明双层防御足够

**未来升级方向**:严重等级 = `high` 且来自非可信用户(阶段5 加身份层后)时硬拒绝,low/medium 仍走"包裹 + 让模型判"路径。

---

## 6. 已知局限与演进路线

| 局限 | 当前症状 | 修复 Task | 备注 |
|------|---------|----------|------|
| 切走会话 = 任务终止 | 切换会话或网络抖动,Run 被 abort,assistant 输出丢失 | **Task 4.5** Run 持久化与续流 | 阶段4 核心改造,最复杂 |
| 无主动取消按钮 | 用户只能切走/关页面,不能"立刻停" | Task 4.5 | 需要新增 POST /sessions/:id/runs/:runId/cancel |
| `[ASK_USER]` 是字符串协议 | 模型偶尔会忘记加前缀;且无法附带结构化 schema | Task 4.5 引入 LangGraph 风格 interrupt | 见 §5.4 |
| 评测无重试 | LLM 服务抖动时单次评测 fail,不可信 | Task 5.3 容错与重试 | 见 exp-02 第 2 轮事故 |
| LLM 请求只盯总时长 | 服务长时间不下发数据但 keep-alive 时 timeout 不触发 | Task 5.3 stream-idle timeout | postChatStream 需要增加空闲监控 |
| `estimateTokens` 精度差 | `length / 2` 在长 prompt 上误差 ±20% | Task 5.5 网关层接入 tiktoken | 不同 tokenizer 不通用是阻塞点 |
| `semantic_search_travel` 工具未实现 | prompt 规则提了,模型尝试调用会失败 | Task 3.3 | testset.ts:sem-01 标 knownFail 跟踪 |
| 多 Agent 协作 | 当前是单 Agent ReAct | Task 5.1 Supervisor 模式 | 阶段5 |
| 注入检测纯靠正则规则 | 规则库有限,新型注入(语义级、多语种变体)可能漏检 | 阶段5 Task 5.3 引入 LLM-as-judge 二次校验 / 规则热更新 | 当前 11 条规则覆盖常见模式;实测 5/5 通过 |
| 输出过滤只做"system prompt 泄露检测" | 没做 PII / 密钥 / 暴力内容过滤 | 阶段5 Task 5.5 网关层 + 项目无 PII 场景暂不紧迫 | 当前项目不涉及个人数据 |

---

## 7. 维护清单(本文档应当何时更新)

| 你改了什么 | 检查本文档哪几节 |
|----------|----------------|
| 新增/删除 HTTP 路由 | §2 API 一览 + §3 对应小节 + §1.1 分层图 |
| 改 `runAgentStream` 主循环 | §3.2.2 ReAct 主循环细节 + §4.2 AG-UI 事件时序 |
| 改 `postChatStream` / LLM 调用 | §3.2.2 + §4.3 Token 链路 + §5.2 |
| 改 prompts/ 目录(新版本、新 section) | §4.1 messages 拼接顺序 + §1.2 模块职责 |
| 改 tools.ts(新工具、改 schema) | §1.2 模块职责 + §3.2.2 ReAct 工具调用部分 |
| 改 abort / 中断行为 | §3.3 中断处理 + §5.5 + §6 |
| 改 chat_sessions / chat_messages schema | §3.4 / §3.5 + §1.2 + §6 局限对照 |
| 落地某个规划 Task | §6 局限表标记移除 + 必要时新增决策小节到 §5 |
| 引入新模块(eval/、rag/、agents/) | §1.1 分层图 + §1.2 职责表 |
| 改 sanitize.ts 规则库 / 检测策略 | §1.2 模块职责 + §3.2 时序图入口节点 + §5.6 决策 + §6 局限表注入检测条目 |

**维护铁律**:任何 PR 涉及上述变更,**必须在 PR 描述里勾选已更新本文档的章节**。Claude Code 接手开发时,提交前应回到本文档自检。

---

## 附录:相关文档

- 开发规划全景:[`../开发规划.md`](../开发规划.md)
- 面试八股(架构决策的"为什么"出处):[`../01-面试八股文/`](../01-面试八股文/)
  - 工程化:`08-工程化实践.md`(容错、Token、可观测)
  - Prompt:`09-Prompt工程.md`(本文档 §4.1 / §5.3 的理论依据)
- 实验记录:[`../02-实验记录/`](../02-实验记录/)
  - `exp-01-temperature.md`(温度选型)
  - `exp-02-prompt-versions.md`(2 轮 prompt 迭代)
- 学习笔记:[`../03-开发笔记/`](../03-开发笔记/)
  - `note-01` LLM 三件套(配合 §4.3 Token 链路读)
  - `note-02` Prompt Engineering(配合 §4.1 + §5.3 读)
