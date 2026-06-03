# 整合阶段 开发笔记:LangGraph 主线切换 + Run-as-Resource（代码改动速查）

> **本文目标**：把 `docs/开发规划.md` 整合阶段 Task 整合-1 / 整合-2 落地的**每一处代码改动**记录清楚，方便下次接手 / 回看 / 排错时直接跳到对应文件，不用逆向猜实现。
>
> 不讲 LangGraph 原理（原理见 `docs/01-面试八股文/02-核心框架.md §6`），只列"做了什么、改了哪、为什么"。
>
> **配套文档**：架构总图 `docs/04-架构文档/agent-架构.md §1.1 / §1.2 / §3 / §4.2 / §6`；数据库迁移 `src/db/migrations/003_agent_runs_events.sql`。
>
> **覆盖范围**：Task 整合-1（LangGraph 主线替换）✅、Task 整合-2（Run-as-Resource 完整版）✅。

---

## 总览

| Task | 一句话 | 新增文件 | 改动文件 |
|------|--------|----------|---------|
| **整合-1** | 用 `createAgent` 替换手写 ReAct 主循环，保持 AG-UI 事件协议不变 | `src/agent/langgraph-agent.ts` `src/agent/langgraphToAgUi.ts` | `src/index.ts` `src/agent/llm.ts`（瘦身） `package.json` |
| **整合-2** | Run-as-Resource 完整版：进程内注册表 + 事件 seq 回放 + 三态 abort + 多订阅者 + 续订 | `src/agent/runManager.ts` `src/db/runRepo.ts` `src/db/migrations/003_agent_runs_events.sql` | `src/index.ts` `src/db/chatRepo.ts` `web/src/App.tsx` `web/src/api.ts` `src/agent/langgraphToAgUi.ts` |

整合阶段的核心决策：**LangGraph 先于 Task 4.x 上主线**——因为 `thread_id` + `Checkpointer` 让续流实现成本远低于手写。这是真实工程常见决策："发现接框架只要 2 天，手写要 2 周，就该接框架。"

---

## Task 整合-1：LangGraph 主线替换

### 关联八股

- `02-核心框架.md §6` LangGraph 状态机 / Q9~Q11 何时选 LangGraph（**首次实践**：用 `createAgent` 实际跑通，对比手写 ReAct 的代码量差异）
- `02-核心框架.md §3` ReAct 循环（手写 vs `createAgent` 的对比，决策记录在本文"关键决策"节）

### 新增 `src/agent/langgraph-agent.ts`（165 行）

LangGraph 版 Agent 入口，跟原 `runAgentStream` **同签名**，handler 切换 0 侵入。

**核心架构**：

```ts
// 进程内 Checkpointer 单例（整合-1 用 MemorySaver，整合-2 未升级）
const checkpointer = new MemorySaver()

// 工具 wrap：把现有 runTool 包成 LangChain tool（闭包绑 sourceMap 做 sources 透传）
function buildTools(pool, config, sourceMap) {
  const wrap = (name, schema, description) =>
    tool(async (input) => {
      const result = await runTool(pool, config, name, JSON.stringify(input))
      if (result.sources) for (const s of result.sources) sourceMap.set(sourceKey(s), s)
      return result.text
    }, { name, description, schema })
  return [wrap('search_destinations', ...), wrap('get_destination_detail', ...), wrap('web_search', ...)]
}

// Agent 入口
export async function* runLangGraphAgent(pool, config, messages, threadId, runId, _resume?, options?) {
  const sourceMap = new Map()
  const agent = createAgent({ model: buildChatModel(config), tools: buildTools(pool, config, sourceMap), systemPrompt, checkpointer })
  const stream = agent.streamEvents(input, { version: 'v2', configurable: { thread_id: runId }, signal: options?.signal })
  yield* translateLangGraphStream(stream, { threadId, runId, sourceMap, onUsage, log })
}
```

**关键设计**：

- **`buildChatModel`**（`langgraph-agent.ts:93`）：`ChatOpenAI` 走 `configuration.baseURL` 对接 MiniMax 兼容协议；`streamUsage: true` 确保流式返回 usage。Task 4.2.A 时 `export` 让 `planner.ts` 复用。
- **工具 wrap 时绑 `sourceMap`（闭包）**（`langgraph-agent.ts:43`）：LangChain tool 只能 return string，sources 通过闭包旁路传出到 `RUN_FINISHED`。
- **`thread_id` 用 `runId` 而非 `sessionId`**（`langgraph-agent.ts:142`）：整合-1 不启用跨请求 thread 复用，每次新 run 都是干净 thread。
- **`[ASK_USER]` 字符串协议保留**：在 adapter 层做 `parseAskUser`，不升级到 LangGraph 原生 `interrupt()`。

### 新增 `src/agent/langgraphToAgUi.ts`（352 行）

LangGraph `streamEvents v2` → AG-UI 事件翻译器。**这是整合-1 最核心的模块**——保证前端 SSE 协议完全不变。

**事件映射表**（`langgraphToAgUi.ts:7-18` 头注释）：

| LangGraph 事件 | AG-UI 事件 |
|---------------|-----------|
| `on_chat_model_start` | `STEP_STARTED('generating')` |
| `on_chat_model_stream` | `TEXT_MESSAGE_START/CONTENT/END` |
| `on_chat_model_end` | usage 累加（`onUsage` 回调） |
| `on_tool_start` | `STEP_STARTED('tool_call')` + `TOOL_CALL_START/ARGS/END` |
| `on_tool_end` | `STEP_FINISHED('tool_call')` + `TOOL_CALL_RESULT` |
| 流自然结束 | 检测 `[ASK_USER]` → `RUN_FINISHED` |
| 流抛错 | `RUN_ERROR` + `RUN_FINISHED` |

**状态机变量**（`langgraphToAgUi.ts:118-132`）：

```ts
let textStarted = false      // 正在输出 text
let thinkingStarted = false  // 正在输出 thinking
let inGeneratingStep = false // 在 generating step 内
let inToolStep = false       // 在 tool_call step 内
let round = 0                // LLM 调用轮次
```

**usage 提取**（`langgraphToAgUi.ts:240-264`）：LangChain 把 usage 放在 `output.usage_metadata`（新格式 `input_tokens/output_tokens`）或 `output.response_metadata.usage`（旧格式 `prompt_tokens/completion_tokens`），adapter 两种都兼容。

**`parseAskUser` 故意 dup**（`langgraphToAgUi.ts:56`）：跟 `llm.ts` 原版逻辑完全一致，但独立维护，避免 `llm.ts` 退役后引用悬空。

### 改 `src/index.ts`：handler 切换

**变更点**：`POST /sessions/:id/stream` 的 agent 调用从 `runAgentStream` 改为 `runManager.start`（整合-2 后进一步改造，见下节）。

### 改 `src/agent/llm.ts`：瘦身

原 `runAgentStream` 完整删除；文件保留 `ChatMessage` / `ResumeItem` / `TokenUsage` 类型导出（下游仍需引用）。当前 34 行（原 200+ 行）。

### 关键决策

| 决策 | 理由 |
|------|------|
| ✅ 主线切换，不保留双 backend | 整合-2 需要 `thread_id + Checkpointer`，手写做不到 |
| ✅ 保留 AG-UI 协议 | adapter 层吸收差异，前端 / 评测脚本 0 改动 |
| ✅ 删除手写代码 | STAR 故事写笔记而非靠死代码留档 |
| ✅ `MemorySaver` 起步 | 最简单实现先跑通，整合-2 不再升级（进程内够用） |
| ❌ 不引入 LangChain 全家桶 | 只装 `langchain` + `@langchain/core` + `@langchain/langgraph` + `@langchain/openai` |
| ❌ 不用 LangGraph 原生 `interrupt()` | `[ASK_USER]` 字符串协议先保留 |

---

## Task 整合-2：Run-as-Resource（完整版）

### 关联八股

- `08-工程化实践.md §1` 容错（**首次实践**：细粒度 abort 三态模型 — per-subscriber vs per-run 互不级联）
- `08-工程化实践.md §3` 全链路可观测（事件日志即审计源，`agent_run_events` 表 = 事件流水）
- `05-记忆系统.md §短期记忆`（事件流水 = episodic memory 的工程形态）
- `02-核心框架.md` Run-as-Resource 模型（"HTTP 请求 ≠ Agent Run"解耦原则）

### 新增 `src/db/migrations/003_agent_runs_events.sql`

3 个 DDL 操作：

```sql
-- 1. agent_runs：完整状态机
CREATE TABLE agent_runs (
  run_id CHAR(36) PRIMARY KEY,
  session_id CHAR(36) NOT NULL,
  status ENUM('pending','running','completed','interrupted','cancelling','cancelled','failed'),
  started_at TIMESTAMP, finished_at TIMESTAMP NULL,
  last_event_seq INT UNSIGNED DEFAULT 0,
  total_tokens INT UNSIGNED DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
  KEY idx_agent_runs_session_status_started (session_id, status, started_at)
)

-- 2. agent_run_events：事件 seq 回放
CREATE TABLE agent_run_events (
  run_id CHAR(36) NOT NULL,
  seq INT UNSIGNED NOT NULL,     -- Run 内单调递增
  event_json JSON NOT NULL,       -- AG-UI 事件全量序列化
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
)

-- 3. chat_sessions 加 status 字段
ALTER TABLE chat_sessions ADD COLUMN status ENUM('running','end') DEFAULT 'end';
```

**关键设计**：
- `last_event_seq` 冗余在 `agent_runs` 上，供 `/runs/active` 续订时秒查（避免 COUNT on events）
- `agent_run_events` 的 `(run_id, seq)` 主键保证续订查询 `seq > N` 走 O(log n) 索引扫描
- FK `ON DELETE CASCADE` 让删除会话时级联清理 runs + events

### 新增 `src/db/runRepo.ts`（178 行）

`agent_runs` / `agent_run_events` 的 CRUD + 启动清理。

**核心函数**：

| 函数 | 位置 | 用途 |
|------|------|------|
| `createRun` | `runRepo.ts:44` | INSERT agent_runs |
| `updateRunStatus` | `runRepo.ts:56` | 状态机推进 + 可选 set finished_at |
| `incrementRunTokens` | `runRepo.ts:72` | Run 结束时累加 total_tokens |
| `getRunById` | `runRepo.ts:84` | 单 Run 查询（cancel / stream 路由用） |
| `getActiveRunBySession` | `runRepo.ts:102` | 查会话最近未完成 Run（GET /runs/active） |
| `markAllRunningAsFailed` | `runRepo.ts:124` | **启动清理**：把残留 running 全标 failed |
| `appendEvent` | `runRepo.ts:139` | 追加事件 + 同步 `last_event_seq`（用 `GREATEST` 防乱序回退） |
| `queryEventsAfter` | `runRepo.ts:159` | 续订查询：`seq > afterSeq ORDER BY seq ASC` |

### 新增 `src/agent/runManager.ts`（421 行）

**整合-2 最核心模块**：进程内 Run 注册表 + 事件总线 + 订阅者管理。

**RunHandle 内部状态**（`runManager.ts:58-80`）：

```ts
type RunHandle = {
  runId: string
  sessionId: string
  status: AgentRunStatus              // 状态机：pending → running → {completed|interrupted|cancelling→cancelled|failed}
  seqCounter: number                  // 内存 seq 递增（串行 yield，无并发问题）
  subscribers: Map<string, Subscriber> // 多订阅者
  abortController: AbortController    // per-run Controller（cancel / SIGTERM / 超时触发）
  currentAssistantMessageId: number | null  // 流式 assistant 消息 stub 的 DB id
  currentAssistantContent: string     // 内存累加，TEXT_MESSAGE_END 时 flush
  totalTokensDelta: number
  log: FastifyBaseLogger              // child logger 已绑 { runId, mode }
  startedAt: number
  toolStats: { count: number; names: string[] }
  mode: RunMode
}
```

**核心方法**：

#### `start()`（`runManager.ts:112-185`）

```
创建 RunHandle → createRun(DB) → updateSessionStatus('running')
→ updateRunStatus('running') → 选择 generator（react vs plan）
→ fire-and-forget pumpRun()
→ 返回 runId（handler 立刻可 subscribe）
```

**关键**：`pumpRun` 是 fire-and-forget——handler 不阻塞等 agent 完成，立刻返回 runId 给前端订阅。这是 Run-as-Resource 的核心解耦。

#### `subscribe()`（`runManager.ts:192-231`）

```
1. 回放历史事件（queryEventsAfter）
2. Run 还活着 → 加入实时广播（subscribers.set）
3. Run 已结束 → 立刻 onEnd()（回放已完成）
返回 unsubscribe 函数
```

**关键设计**：同一 Run 可多个订阅者（多 tab 打开同会话），subscriber 异常 catch 吞掉避免拖垮 pump。

#### `cancel()`（`runManager.ts:237-254`）

```
handle.status = 'cancelling' → updateRunStatus(DB) → handle.abortController.abort()
```

幂等：已 cancelled / completed 等终态调用是 no-op。内存中已无（Run 已结束）时查 DB 兜底。

#### `pumpRun()`（`runManager.ts:269-291`）— 事件泵

```ts
for await (const event of generator) {
  await handleEvent(handle, event)  // 写 DB + 持久化 assistant + 广播 subscribers
}
// catch: cancelling 中收 abort → cancelled；否则 failed
// finally: finalize(handle, status)
```

#### `handleEvent()`（`runManager.ts:293-321`）

每个事件的处理：
1. `appendEvent` 写 `agent_run_events`（顺序保证）
2. `persistAssistantMessage`：首次 `TEXT_MESSAGE_CONTENT` 时 INSERT stub，`TEXT_MESSAGE_END` 时 UPDATE 整条 content
3. 累加 `toolStats`（给 finalize 的 run summary 用）
4. 广播给所有 subscriber（吞异常）

#### `finalize()`（`runManager.ts:353-416`）

```
flush 遗留 assistant content → updateRunStatus(DB, status, finished_at)
→ updateSessionStatus('end') → incrementRunTokens
→ 通知所有 subscriber onEnd → 清理内存 runs.delete
→ 打 'run summary' 索引日志
```

### 改 `src/db/chatRepo.ts`：新增 4 个函数

| 函数 | 位置 | 用途 |
|------|------|------|
| `updateSessionStatus` | `chatRepo.ts:115` | 更新 `chat_sessions.status`（'running' / 'end'） |
| `getSessionStatus` | `chatRepo.ts:123` | GET /messages 返回 status 字段 |
| `markAllSessionsAsEnd` | `chatRepo.ts:138` | 启动清理：配对 `markAllRunningAsFailed` |
| `insertAssistantStub` | `chatRepo.ts:153` | 流式中 INSERT 空 content 占位行，返回 id |
| `updateAssistantContent` | `chatRepo.ts:161` | TEXT_MESSAGE_END 时 UPDATE 整条 content |

**设计要点**：assistant 消息用"INSERT stub + 增量 UPDATE"模式，避免每 token 一条 INSERT 行数爆炸。

### 改 `src/index.ts`：Run-as-Resource 路由改造

**新增 3 个路由**：

| 路由 | 位置 | 用途 |
|------|------|------|
| `GET /sessions/:id/runs/active` | `index.ts:123` | 前端打开会话时查最近未完成 Run |
| `POST /sessions/:id/runs/:runId/cancel` | `index.ts:140` | 用户主动停止 Run（202 + 幂等） |
| `GET /sessions/:id/runs/:runId/stream?after_seq=N` | `index.ts:159` | 续订：先回放历史事件，再接实时流 |

**改造既有路由**：

- `POST /sessions/:id/stream`（`index.ts:222`）：不再自己 yield agent stream，改为 `runManager.start` + `subscribe`。`req.raw 'close'` 钩子改为 `unsubscribe()`（**不再 abort Run**）。
- `GET /sessions/:id/messages`（`index.ts:74`）：返回新增 `status` 字段。
- `DELETE /sessions/:id`（`index.ts:100`）：删除前先 cancel 活跃 Run（避免内存里 RunHandle 引用已删 session）。

**`POST /sessions/:id/stream` 的关键改动**（`index.ts:294-368`）：

```ts
// 1. 启动 Run（fire-and-forget）
const runId = await runManager.start(sessionId, msgs, reqLog, mode)

// 2. subscribe：事件转发给当前请求 SSE
const unsubscribe = await runManager.subscribe(runId, onEvent, onEnd, 0)

// 3. 客户端断开 = 只 unsubscribe，Run 继续跑
req.raw.once('close', () => {
  unsubscribe()
  reqLog.info({ runId }, 'client unsubscribed (run continues in background)')
})
```

### 改 `web/src/api.ts`：新增 3 个前端 API 函数

| 函数 | 位置 | 用途 |
|------|------|------|
| `getActiveRun` | `api.ts:59` | `GET /runs/active`（供续订判断） |
| `cancelRun` | `api.ts:66` | `POST /cancel`（主动停止） |
| `resumeRunStream` | `api.ts:134` | `GET /runs/:runId/stream?after_seq=N`（续订流） |

新增类型：`SessionStatus`、`AgentRunRow`。

`parseSseStream` 抽为公共函数（`api.ts:150`），`sendMessageStream` 和 `resumeRunStream` 复用。

### 改 `web/src/App.tsx`：会话续订 + 停止按钮

**核心改动**：

| 功能 | 位置 | 说明 |
|------|------|------|
| `streamCtrlRef` + `currentRunIdRef` | `App.tsx:38-40` | per-session abort + per-run runId 追踪 |
| `switchSession()` | `App.tsx:80-123` | status='running' → `getActiveRun` → 启动续订（`startResume`） |
| `startResume()` | `App.tsx:126-141` | 调 `resumeRunStream(sid, runId, 0)` → 走 `consumeStream` 公共事件循环 |
| `handleStop()` | `App.tsx:164-174` | 调 `cancelRun` + `abortInFlight` |
| 停止按钮 | `App.tsx:657-660` | `sending && currentRunIdRef.current` 时显示 |
| `consumeStream()` | `App.tsx:251-401` | 公共事件循环，被 `handleSend` / `handleOptionClick` / `startResume` 三处复用 |

**续订流程**：

```
switchSession(id) → GET /messages（拿 status）
  status='running' → getActiveRun(id)
    有活跃 Run → 剔除最后一条 assistant（回放会重建它）
               → startResume(id, runId)
               → resumeRunStream(id, runId, 0)
               → consumeStream（事件循环）
```

**三态 abort 前端侧**：

| 场景 | 前端行为 | 后端行为 |
|------|---------|---------|
| 切换会话 | `streamCtrlRef.abort()`（断开 SSE） | Run 继续跑 + 持续写库 |
| 主动停止 | `cancelRun` + `abortInFlight` | `runManager.cancel` → abort Run |
| 关闭标签页 | 浏览器 close → SSE 断开 | Run 继续跑 |

### 改 `src/agent/langgraphToAgUi.ts`：事件持久化

整合-2 后每 yield 一个 AG-UI 事件，`runManager.handleEvent` 同步调 `repoAppendEvent` 写 `agent_run_events`。adapter 本身不变，持久化由 `runManager` 层包裹。

### 关键决策

| 决策 | 理由 |
|------|------|
| ✅ 完整三态 abort | per-subscriber 仅 unsubscribe，per-run 才真 abort；两个 Controller 互不级联 |
| ✅ 事件级 seq 回放 | `(run_id, seq)` 主键，续订 `seq > N` O(log n) 扫描 |
| ✅ 多订阅者并发 | 同 Run 多 subscriber 共享事件流（多 tab 场景） |
| ✅ 进程重启标 failed | `markAllRunningAsFailed` + `markAllSessionsAsEnd` 配对调用 |
| ✅ assistant 消息 stub + 增量 UPDATE | 避免每 token 一行 INSERT |
| ⚠️ 进程重启不自动续跑 | LangGraph 重建 stream + 复用 checkpoint 复杂度不匹配，推迟 |
| ❌ Checkpointer 未升级 | 继续 `MemorySaver`（进程内），SqliteSaver/MySQLSaver 推迟 |
| ❌ 跨进程方案推迟 | Redis Pub/Sub 留给 Task 5.4 容器化 |

---

## 附录：全部代码改动速查

| 改动类型 | 路径 | Task | 改动一句话 |
|---------|------|------|------|
| **新增** | `src/agent/langgraph-agent.ts` | 整合-1 | `createAgent` + 工具 wrap + `buildChatModel`（165 行） |
| | `src/agent/langgraphToAgUi.ts` | 整合-1 | LangGraph streamEvents v2 → AG-UI 翻译器（352 行） |
| | `src/agent/runManager.ts` | 整合-2 | 进程内 Run 注册表 + 事件总线 + 三态 abort（421 行） |
| | `src/db/runRepo.ts` | 整合-2 | agent_runs / agent_run_events CRUD + 启动清理（178 行） |
| | `src/db/migrations/003_agent_runs_events.sql` | 整合-2 | agent_runs + agent_run_events 表 + chat_sessions.status 字段 |
| **改代码** | `src/index.ts` | 整合-1 + 整合-2 | handler 从直接调 agent 改为 `runManager.start + subscribe`；新增 3 个 Run 路由 |
| | `src/agent/llm.ts` | 整合-1 | 删除 `runAgentStream`，瘦身为类型导出（34 行） |
| | `src/db/chatRepo.ts` | 整合-2 | 新增 `SessionStatus` + 5 个函数（status / stub / flush / 启动清理） |
| **改前端** | `web/src/api.ts` | 整合-2 | 新增 `getActiveRun` / `cancelRun` / `resumeRunStream` + `parseSseStream` 公共化 |
| | `web/src/App.tsx` | 整合-2 | 会话续订（`switchSession` → `startResume`）+ 停止按钮 + `consumeStream` 公共化 |
| **依赖** | `package.json` | 整合-1 | `langchain` + `@langchain/core` + `@langchain/langgraph` + `@langchain/openai`（4 个最小包） |
| **文档同步** | `docs/04-架构文档/agent-架构.md` | 整合-1 + 整合-2 | §1.1 分层图加 runManager / §3.3 中断处理改写 / §6 局限表更新 |

---

## 验证命令

```bash
# 0. 切 Node 22（LangChain 1.x 要 >=20）
nvm use 22

# 1. 类型检查
npx tsc --noEmit

# 2. 迁移数据库
npx tsx scripts/migrate.ts

# 3. 基础回归（确保 LangGraph 替换后功能不变）
npm run eval -- --version v1_base --case ask-01,detail-01,inj-01,web-01 --sleep 1000
# 期望：pass=4/4 hardFailRate=0.0%

# 4. 续订验证（启动 dev server 后）
# 4.1 发一条消息，记录 runId
curl -X POST http://localhost:3001/sessions/<SID>/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"推荐一下成都美食"}' --max-time 5
# Ctrl-C 中断（模拟切走）

# 4.2 查活跃 Run
curl http://localhost:3001/sessions/<SID>/runs/active | jq

# 4.3 续订（从 seq=0 完整回放）
curl http://localhost:3001/sessions/<SID>/runs/<RUN_ID>/stream?after_seq=0

# 5. 主动取消验证
curl -X POST http://localhost:3001/sessions/<SID>/runs/<RUN_ID>/cancel
# 期望：202 { "cancelled": true }

# 6. 重启降级验证
# 6.1 发消息中途 kill 进程
# 6.2 重启后检查
curl http://localhost:3001/sessions/<SID>/messages | jq '.status'
# 期望："end"（启动清理已执行）
```
