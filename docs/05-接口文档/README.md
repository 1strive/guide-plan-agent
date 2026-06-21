# API 接口文档

> 本文档对应 `src/index.ts` 中注册的全部 HTTP 路由，基础地址默认 `http://localhost:{PORT}`（端口见 `.env` 配置）。

---

## 目录

| #   | 方法   | 路径                               | 用途               |
| --- | ------ | ---------------------------------- | ------------------ |
| 1   | GET    | `/health`                          | 健康检查           |
| 2   | GET    | `/metrics`                         | 运行指标           |
| 3   | GET    | `/sessions`                        | 会话列表           |
| 4   | POST   | `/sessions`                        | 创建会话           |
| 5   | DELETE | `/sessions/:id`                    | 删除会话           |
| 6   | GET    | `/sessions/:id/messages`           | 获取会话消息       |
| 7   | GET    | `/sessions/:id/runs/active`        | 获取活跃 Run       |
| 8   | POST   | `/sessions/:id/runs/:runId/cancel` | 取消 Run           |
| 9   | GET    | `/sessions/:id/runs/:runId/stream` | 续订 Run 事件流    |
| 10  | POST   | `/sessions/:id/stream`             | Agent 流式对话入口 |

---

## 1. GET /health

**用途**：服务健康检查，探测 MySQL 与 Redis 是否可达。

**请求**：无参数

**响应**：

```jsonc
// 200 OK
{ "ok": true, "db": true, "redis": true }

// 503 Service Unavailable（MySQL 或 Redis 不可达）
{ "ok": false, "error": "..." }
```

---

## 2. GET /metrics

**用途**：获取进程内轻量运行指标（内存计数，非 Prometheus）。

**请求**：无参数

**响应 200**：

```jsonc
{
  "totalRuns": 42, // 累计 Run 数
  "completedRuns": 38, // 成功（含 interrupted）
  "failedRuns": 4, // 失败
  "errorRate": 0.095, // 失败率
  "avgDurationMs": 3200, // 平均耗时 ms
  "totalTokens": 128000, // 累计消耗 token
  "recentErrors": [
    // 最近 5 条错误摘要
    { "time": "ISO string", "runId": "uuid", "error": "reason" },
  ],
}
```

---

## 3. GET /sessions

**用途**：列出所有会话（按创建时间倒序）。

**请求**：无参数

**响应 200**：

```jsonc
{
  "sessions": [
    {
      "id": "uuid",
      "title": "帮我规划北京三日游",
      "createdAt": "...",
      "updatedAt": "...",
    },
  ],
}
```

---

## 4. POST /sessions

**用途**：创建一个新会话。

**请求**：无 Body

**响应 201**：

```jsonc
{ "sessionId": "uuid" }
```

---

## 5. DELETE /sessions/:id

**用途**：删除指定会话。若该会话有活跃 Run，会先自动 cancel 后再删除。关联的 messages / agent_runs / archived_run_events 通过 FK CASCADE 级联清理。

**路径参数**：

| 参数 | 类型          | 说明    |
| ---- | ------------- | ------- |
| id   | string (UUID) | 会话 ID |

**响应**：

```jsonc
// 204 No Content — 删除成功（无 Body）

// 404 Not Found
{ "error": "session not found" }
```

---

## 6. GET /sessions/:id/messages

**用途**：获取指定会话的全部消息列表，并返回当前会话状态（`running` / `end`）。前端据此判断是否需要续订活跃 Run。

**路径参数**：

| 参数 | 类型          | 说明    |
| ---- | ------------- | ------- |
| id   | string (UUID) | 会话 ID |

**响应 200**：

```jsonc
{
  "messages": [
    { "id": "uuid", "role": "user", "content": "...", "createdAt": "..." },
    { "id": "uuid", "role": "assistant", "content": "...", "createdAt": "..." },
  ],
  "status": "end", // "running" | "end"
}
```

**错误**：

```jsonc
// 404
{ "error": "session not found" }
```

---

## 7. GET /sessions/:id/runs/active

**用途**：获取指定会话最近一个未完成的 Run 元数据（供前端进入会话时判断是否续订）。

**路径参数**：

| 参数 | 类型          | 说明    |
| ---- | ------------- | ------- |
| id   | string (UUID) | 会话 ID |

**响应 200**：

```jsonc
// 有活跃 Run
{ "active": { "runId": "uuid", "status": "running", "startedAt": "..." } }

// 无活跃 Run
{ "active": null }
```

**错误**：

```jsonc
// 404
{ "error": "session not found" }
```

---

## 8. POST /sessions/:id/runs/:runId/cancel

**用途**：用户主动取消指定 Run。幂等，重复调用不会报错。

**路径参数**：

| 参数  | 类型          | 说明    |
| ----- | ------------- | ------- |
| id    | string (UUID) | 会话 ID |
| runId | string (UUID) | Run ID  |

**响应 202 Accepted**：

```jsonc
{ "cancelled": true }   // 成功取消
{ "cancelled": false }  // Run 已不处于活跃状态
```

**错误**：

```jsonc
// 404（runId 不存在 或 不属于该 session）
{ "error": "run not found" }
```

---

## 9. GET /sessions/:id/runs/:runId/stream

**用途**：续订接口（SSE）。先回放 `seq > after_seq` 的历史事件，再接实时流（若 Run 仍活跃）。若 Run 已结束，只回放历史并立即关流。

**路径参数**：

| 参数  | 类型          | 说明    |
| ----- | ------------- | ------- |
| id    | string (UUID) | 会话 ID |
| runId | string (UUID) | Run ID  |

**查询参数**：

| 参数      | 类型   | 默认值 | 说明                 |
| --------- | ------ | ------ | -------------------- |
| after_seq | number | 0      | 从该序号之后开始回放 |

**响应**：`text/event-stream`（SSE）

```
data: {"type":"TEXT_MESSAGE_START","messageId":"...","role":"assistant"}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"...","delta":"你好"}

data: {"type":"RUN_FINISHED","runId":"...","outcome":{"type":"complete"}}
```

**响应头**：

| Header            | 值                               |
| ----------------- | -------------------------------- |
| Content-Type      | text/event-stream; charset=utf-8 |
| Cache-Control     | no-cache                         |
| Connection        | keep-alive                       |
| X-Accel-Buffering | no                               |
| X-Trace-Id        | {runId}                          |

**心跳**：每 15 秒发送 `: ping\n\n` 防网关 idle 断连。

**错误**：

```jsonc
// 404
{ "error": "run not found" }
```

---

## 10. POST /sessions/:id/stream

**用途**：Agent 流式对话入口（核心接口）。接收用户消息，启动 ReAct 循环 Run，以 SSE 实时推送 AG-UI 事件。

**路径参数**：

| 参数 | 类型          | 说明    |
| ---- | ------------- | ------- |
| id   | string (UUID) | 会话 ID |

**请求 Body**（JSON）：

| 字段          | 类型   | 必填 | 说明                                             |
| ------------- | ------ | ---- | ------------------------------------------------ |
| message       | string | ✅   | 用户消息内容                                     |
| promptVersion | string | ❌   | 指定 Prompt 版本，默认取 `config.PROMPT_VERSION` |

**响应**：`text/event-stream`（SSE）

事件类型遵循 AG-UI 协议（详见 `docs/03-开发笔记/note-05-AG-UI协议文档.md`），常见事件序列：

```
data: {"type":"RUN_STARTED","runId":"...","sessionId":"..."}

data: {"type":"TEXT_MESSAGE_START","messageId":"...","role":"assistant"}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"...","delta":"推荐"}

data: {"type":"TEXT_MESSAGE_END","messageId":"..."}

data: {"type":"RUN_FINISHED","runId":"...","outcome":{"type":"complete"}}
```

工具调用场景追加：

```
data: {"type":"TOOL_CALL_START","toolCallId":"...","name":"search_destination"}

data: {"type":"TOOL_CALL_ARGS","toolCallId":"...","delta":"{\"query\":\"北京景点\"}"}

data: {"type":"TOOL_CALL_END","toolCallId":"..."}

data: {"type":"TOOL_RESULT","toolCallId":"...","result":"..."}
```

**响应头**：同 §9。

**行为说明**：

- 用户消息在发起时即持久化到 `chat_messages` 表
- 首条消息自动截取前 30 字作为会话标题
- 入口检测 Prompt 注入，命中时 wrap `<untrusted_user_content>` 标签
- 客户端断开连接 ≠ 取消 Run；Run 在后台继续跑、持续写库
- Run 完成后进行出口注入检测（system prompt 泄漏告警）

**错误**：

```jsonc
// 400
{ "error": "message required" }

// 404
{ "error": "session not found" }
```

---

## 通用说明

### SSE 事件格式

所有 SSE 接口的事件均为 `data:` 行 + JSON 字符串，无自定义 `event:` 字段：

```
data: {JSON}\n\n
```

### 错误处理

- 非 SSE 接口统一返回 `{ "error": "描述" }` + 对应 HTTP 状态码
- SSE 接口在握手阶段（未 hijack 前）可能返回 404 JSON；握手后错误通过 `RUN_ERROR` 事件推送

### CORS

已通过 `@fastify/cors` 开启全来源跨域（`origin: true`）。

### 认证

当前无认证机制（本地开发 / 学习项目），所有接口公开访问。
