# AG-UI SSE 事件协议文档

> **本文目标**:前端开发时的速查手册——服务端通过 SSE 推送哪些事件、每个事件的字段结构、前端应如何消费渲染。
>
> **协议来源**:`src/agent/ag-ui.ts`(类型定义 + 构造器)
> **事件翻译层**:`src/agent/langgraphToAgUi.ts`(LangGraph 内部事件 → AG-UI 事件)

---

## 1. 传输层

| 项           | 值                                                           |
| ------------ | ------------------------------------------------------------ |
| 协议         | Server-Sent Events(SSE)                                      |
| Content-Type | `text/event-stream; charset=utf-8`                           |
| 帧格式       | `data: {JSON}\n\n`                                           |
| 心跳         | `: ping\n\n`(每 15s,SSE 注释行,客户端忽略)                   |
| 响应头       | `X-Trace-Id: <runId>`(日志关联用)                            |
| 连接关闭     | 服务端 `reply.raw.end()`;客户端断开仅 unsubscribe,Run 继续跑 |

### SSE 入口

| 接口                                           | 方法                             | 用途                      |
| ---------------------------------------------- | -------------------------------- | ------------------------- |
| `/sessions/:id/stream`                         | POST body: `{ message: string }` | 发起新对话                |
| `/sessions/:id/runs/:runId/stream?after_seq=N` | GET                              | 续订(先回放历史,再接实时) |

---

## 2. 事件类型完整列表(15 种)

### 2.1 生命周期事件

#### RUN_STARTED

Run 创建,流开始。

```json
{
  "type": "RUN_STARTED",
  "threadId": "session-uuid",
  "runId": "run-uuid",
  "timestamp": 1780808655181
}
```

| 字段      | 类型   | 说明                 |
| --------- | ------ | -------------------- |
| threadId  | string | 会话 ID(= sessionId) |
| runId     | string | 本次 Run 唯一标识    |
| timestamp | number | 毫秒时间戳           |

**前端动作**:保存 `runId` 到 ref(给「停止」按钮 / 续订用),不渲染。

---

#### RUN_FINISHED

Run 结束(正常完成 / 反问中断 / 取消后)。**这是 SSE 流的最后一个业务事件**。

```json
{
  "type": "RUN_FINISHED",
  "threadId": "session-uuid",
  "runId": "run-uuid",
  "outcome": { "type": "success" },
  "usage": {
    "promptTokens": 1200,
    "completionTokens": 300,
    "totalTokens": 1500
  },
  "sources": [
    {
      "type": "mcp",
      "name": "amap",
      "metadata": { "tool": "maps_search_nearby" }
    }
  ],
  "timestamp": 1780808660000
}
```

| 字段    | 类型                                                                               | 说明                       |
| ------- | ---------------------------------------------------------------------------------- | -------------------------- |
| outcome | `{ type: 'success' }` 或 `{ type: 'interrupt', interrupts: [...] }` 或 `undefined` | 结束原因                   |
| usage   | `{ promptTokens, completionTokens, totalTokens }` 或 undefined                     | 本次 token 消耗            |
| sources | `Source[]` 或 undefined                                                            | 引用过的数据来源(MCP 工具) |

**outcome.type 取值**:

| outcome.type  | 含义                     | 前端动作                |
| ------------- | ------------------------ | ----------------------- |
| `"success"`   | 正常完成                 | 标记流结束,刷新会话列表 |
| `"interrupt"` | 反问,需要用户补充信息    | 渲染选项按钮            |
| `undefined`   | 异常结束(伴随 RUN_ERROR) | 同 error 处理           |

**interrupt 子结构**(outcome.type = "interrupt" 时):

```json
{
  "type": "interrupt",
  "interrupts": [
    {
      "id": "interrupt-uuid",
      "reason": "input_required",
      "message": "请问您从哪个城市出发?",
      "metadata": {
        "options": ["华东地区", "华南地区", "华北地区", "其他"]
      }
    }
  ]
}
```

| 字段                           | 说明                  |
| ------------------------------ | --------------------- |
| interrupts[0].id               | 反问 ID,resume 时回传 |
| interrupts[0].message          | 反问文本(展示给用户)  |
| interrupts[0].metadata.options | 选项列表(渲染为按钮)  |

---

#### RUN_ERROR

Run 执行出错(LLM 超时 / 工具失败 / 内部异常)。通常紧跟 RUN_FINISHED(outcome=undefined)。

```json
{
  "type": "RUN_ERROR",
  "message": "TimeoutError: Request timed out.",
  "code": "AGENT_ERROR",
  "timestamp": 1780808655181
}
```

| 字段    | 类型                | 说明       |
| ------- | ------------------- | ---------- |
| message | string              | 错误描述   |
| code    | string 或 undefined | 错误分类码 |

**前端动作**:在当前 assistant 消息中追加 `[错误] ${message}`。

---

### 2.2 步骤事件

#### STEP_STARTED / STEP_FINISHED

标记 Agent 进入/离开某个执行阶段。

```json
{ "type": "STEP_STARTED", "stepName": "generating", "timestamp": ... }
{ "type": "STEP_FINISHED", "stepName": "generating", "timestamp": ... }
```

**stepName 取值**:

| stepName           | 含义         | 说明                              |
| ------------------ | ------------ | --------------------------------- |
| `"generating"`     | LLM 正在生成 | 包含 THINKING + TEXT_MESSAGE 事件 |
| `"tool_call"`      | 准备调工具   | 包含 TOOL_CALL_START/ARGS/END     |
| `"tool_execution"` | 工具执行中   | 包含 TOOL_CALL_RESULT             |

**前端动作**(可选):顶部进度条 / 状态标签切换。不渲染也不影响功能。

---

### 2.3 文本消息事件

#### TEXT_MESSAGE_START

一段 assistant 回答文本的起点。

```json
{
  "type": "TEXT_MESSAGE_START",
  "messageId": "msg-uuid",
  "role": "assistant",
  "timestamp": ...
}
```

---

#### TEXT_MESSAGE_CONTENT

文本增量(高频事件,流式逐 token 推送)。

```json
{
  "type": "TEXT_MESSAGE_CONTENT",
  "messageId": "msg-uuid",
  "delta": "丽江是一个",
  "timestamp": ...
}
```

| 字段  | 说明                                             |
| ----- | ------------------------------------------------ |
| delta | 本次增量文本片段(UTF-8,可能是 1 个字 ~ 几十个字) |

**前端动作**:累加 `delta` 到 assistant 消息的 `content` 字段,实时刷新渲染。

---

#### TEXT_MESSAGE_END

文本回答结束(同一 Run 内可能出现多次 START/END 对,因为 ReAct 多轮)。

```json
{ "type": "TEXT_MESSAGE_END", "messageId": "msg-uuid", "timestamp": ... }
```

---

### 2.4 思考过程事件

> 跟 TEXT_MESSAGE 完全平行的独立流。MiniMax 模型把 `<think>...</think>` 内联到 content,adapter 拆出来发这组事件。同一轮内可能 think → text 交错。

#### THINKING_START

```json
{ "type": "THINKING_START", "messageId": "think-uuid", "timestamp": ... }
```

---

#### THINKING_CONTENT

思考增量(语义是"模型内部推理",不是"对外回答")。

```json
{
  "type": "THINKING_CONTENT",
  "messageId": "think-uuid",
  "delta": "用户问的是丽江美食,我应该调用高德POI搜索...",
  "timestamp": ...
}
```

**前端动作**:累加到 `thinking` 字段,折叠区显示(默认收起)。

---

#### THINKING_END

```json
{ "type": "THINKING_END", "messageId": "think-uuid", "timestamp": ... }
```

---

### 2.5 工具调用事件

#### TOOL_CALL_START

开始调用某个 MCP 工具。

```json
{
  "type": "TOOL_CALL_START",
  "toolCallId": "tc-uuid",
  "toolCallName": "maps_search_nearby",
  "timestamp": ...
}
```

| 字段         | 说明                           |
| ------------ | ------------------------------ |
| toolCallId   | 本次工具调用唯一 ID            |
| toolCallName | 工具名(MCP server 注册的 name) |

**前端动作**:显示工具调用 chip(名称 + ⏳ 状态)。

---

#### TOOL_CALL_ARGS

工具参数(JSON 字符串,可能流式分多次发或一次性)。

```json
{
  "type": "TOOL_CALL_ARGS",
  "toolCallId": "tc-uuid",
  "delta": "{\"query\":\"丽江美食\",\"city\":\"丽江\"}",
  "timestamp": ...
}
```

**前端动作**(可选):展开显示工具入参(调试/透明度用)。

---

#### TOOL_CALL_END

参数发送完毕,工具即将开始执行。

```json
{ "type": "TOOL_CALL_END", "toolCallId": "tc-uuid", "timestamp": ... }
```

---

#### TOOL_CALL_RESULT

工具执行结果返回。

```json
{
  "type": "TOOL_CALL_RESULT",
  "messageId": "result-msg-uuid",
  "toolCallId": "tc-uuid",
  "content": "{\"pois\":[{\"name\":\"腊排骨火锅\",\"address\":\"古城区...\"}]}",
  "role": "tool",
  "timestamp": ...
}
```

| 字段       | 说明                                 |
| ---------- | ------------------------------------ |
| content    | 工具返回的原始 JSON 字符串(可能很长) |
| toolCallId | 对应 TOOL_CALL_START 的 ID           |

**前端动作**:工具 chip 状态 → ✅;可选展开显示结果摘要。

---

## 3. 事件时序图

### 正常对话(带工具调用)

```
RUN_STARTED
│
├── STEP_STARTED("generating")
│   ├── THINKING_START              ← 模型思考(可选)
│   ├── THINKING_CONTENT × N
│   ├── THINKING_END
│   ├── TEXT_MESSAGE_START
│   ├── TEXT_MESSAGE_CONTENT × N    ← 流式回答
│   └── TEXT_MESSAGE_END
├── STEP_FINISHED("generating")
│
├── STEP_STARTED("tool_call")       ← LLM 决定调工具
│   ├── TOOL_CALL_START
│   ├── TOOL_CALL_ARGS
│   └── TOOL_CALL_END
├── STEP_FINISHED("tool_call")
│
├── STEP_STARTED("tool_execution")  ← 工具执行
│   └── TOOL_CALL_RESULT
├── STEP_FINISHED("tool_execution")
│
├── (重复 generating → tool_call → tool_execution ...)
│
├── STEP_STARTED("generating")      ← 最终整合回答
│   ├── THINKING_START / CONTENT / END
│   ├── TEXT_MESSAGE_START / CONTENT × N / END
├── STEP_FINISHED("generating")
│
└── RUN_FINISHED { outcome: { type: "success" }, usage, sources }
```

### 反问场景(信息不足)

```
RUN_STARTED
├── STEP_STARTED("generating")
│   ├── THINKING_START / CONTENT / END
│   ├── TEXT_MESSAGE_START
│   ├── TEXT_MESSAGE_CONTENT("[ASK_USER]\n请问您从哪个城市出发?...")
│   └── TEXT_MESSAGE_END
├── STEP_FINISHED("generating")
└── RUN_FINISHED { outcome: { type: "interrupt", interrupts: [...] } }
```

### 错误场景(LLM 超时)

```
RUN_STARTED
├── RUN_ERROR { message: "TimeoutError: ...", code: "AGENT_ERROR" }
└── RUN_FINISHED { outcome: undefined, usage: { totalTokens: 0 } }
```

### 纯文本回答(不调工具)

```
RUN_STARTED
├── STEP_STARTED("generating")
│   ├── THINKING_START / CONTENT × N / END
│   ├── TEXT_MESSAGE_START / CONTENT × N / END
├── STEP_FINISHED("generating")
└── RUN_FINISHED { outcome: { type: "success" } }
```

---

## 4. HTTP REST 接口汇总(非 SSE)

| Method | Path                               | 请求 | 响应                                                                                            | 用途                    |
| ------ | ---------------------------------- | ---- | ----------------------------------------------------------------------------------------------- | ----------------------- |
| GET    | `/health`                          | —    | `{ ok: boolean, db: boolean }`                                                                  | 健康检查                |
| GET    | `/metrics`                         | —    | `{ totalRuns, completedRuns, failedRuns, errorRate, avgDurationMs, totalTokens, recentErrors }` | 运行统计                |
| GET    | `/sessions`                        | —    | `{ sessions: SessionItem[] }`                                                                   | 会话列表                |
| POST   | `/sessions`                        | —    | `201 { sessionId: string }`                                                                     | 创建空会话              |
| GET    | `/sessions/:id/messages`           | —    | `{ messages: ChatMsg[], status: 'running'\|'end' }`                                             | 历史消息 + 状态         |
| DELETE | `/sessions/:id`                    | —    | `204`                                                                                           | 删除会话(FK 级联清消息) |
| GET    | `/sessions/:id/runs/active`        | —    | `{ active: AgentRunRow \| null }`                                                               | 查活跃 Run(续订用)      |
| POST   | `/sessions/:id/runs/:runId/cancel` | —    | `202 { cancelled: boolean }`                                                                    | 主动停止 Run            |

### SessionItem 结构

```ts
{
  id: string;
  title: string | null;
  totalTokens: number;
  createdAt: string;
  lastMessage: string | null; // Sidebar preview：最近一条消息 content（任意 role）
  messageCount: number; // Sidebar badge：user+assistant 计数
}
```

### AgentRunRow 结构

```ts
{
  runId: string;
  sessionId: string;
  status: "pending" |
    "running" |
    "completed" |
    "interrupted" |
    "cancelling" |
    "cancelled" |
    "failed";
  startedAt: string;
  finishedAt: string | null;
  lastEventSeq: number;
  totalTokens: number;
}
```

---

## 5. 前端渲染优先级建议

| 事件                    |   优先级    | 建议 UI                            |
| ----------------------- | :---------: | ---------------------------------- |
| TEXT_MESSAGE_CONTENT    | **P0 必须** | 主回答区,流式追加文本              |
| RUN_FINISHED(interrupt) | **P0 必须** | 反问文本 + 选项按钮                |
| RUN_ERROR               | **P0 必须** | 错误提示(红色/警告样式)            |
| TOOL_CALL_START         | **P1 推荐** | 工具调用 chip(工具名 + ⏳ loading) |
| TOOL_CALL_END           | **P1 推荐** | chip 状态 ⏳ → ✅                  |
| THINKING_CONTENT        | **P1 推荐** | 折叠区"思考过程",灰色小字,默认收起 |
| TOOL_CALL_RESULT        |   P2 可选   | 展开查看工具返回结果(JSON 格式化)  |
| TOOL_CALL_ARGS          |   P2 可选   | 展开查看工具入参                   |
| STEP_STARTED/FINISHED   |   P2 可选   | 顶部进度条 / 阶段标签              |
| RUN_STARTED             |   P3 内部   | 存 runId,不渲染                    |
| TEXT_MESSAGE_START/END  |   P3 内部   | 控制流边界,不直接渲染              |
| THINKING_START/END      |   P3 内部   | 控制 thinking 折叠区显隐           |

---

## 6. 前端续订流程

当用户切走会话再回来(或刷新页面)时:

```
1. GET /sessions/:id/messages → { status: 'running' } ?
2. 是 → GET /sessions/:id/runs/active → { active: { runId, lastEventSeq } }
3. 连 GET /sessions/:id/runs/:runId/stream?after_seq=0
4. 服务端先回放所有历史事件(从 Redis Stream 或 archived_run_events 冷库读)
5. 若 Run 仍活跃 → 接实时流;若已结束 → 回放完直接关流
6. 前端用跟 consumeStream 完全相同的事件循环处理(无需区分首次 vs 续订)
```

---

## 7. 前端主动停止流程

```
1. 用户点「停止」按钮
2. POST /sessions/:id/runs/:runId/cancel → 202
3. 服务端 abort LangGraph stream → Run 状态推进 cancelling → cancelled
4. 前端收到 RUN_FINISHED(或连接关闭)→ setSending(false)
5. 前端同时 abortController.abort() 关 SSE 连接
```
