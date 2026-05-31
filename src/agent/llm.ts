/**
 * Agent 通用类型(瘦身版)
 *
 * 历史:本文件原本承载手写 ReAct 主循环(`runAgentStream`)+ OpenAI SSE 解析
 * (`postChatStream`),Task 整合-1(2026-05-31)切到 LangGraph 主线后整体废弃。
 *
 * 当前只保留**业务层共用的 3 个类型**,被 `langgraph-agent.ts` / `index.ts` /
 * `eval/runner.ts` / `eval/testset.ts` 等模块复用。
 *
 * 主路径实现:`src/agent/langgraph-agent.ts`(基于 langchain.createAgent)
 * 事件翻译:`src/agent/langgraphToAgUi.ts`(LangGraph → AG-UI 事件)
 * "手写 vs LangGraph"对比 STAR 故事:`docs/03-开发笔记/note-04`(待写)
 */

import type { TokenUsage } from './token-usage.js'

export type { TokenUsage }

/**
 * 业务层 chat message,跟 OpenAI 协议对齐(role + content),
 * assistant 可携带 tool_calls,tool 必须带 tool_call_id。
 *
 * 注:LangGraph 内部用 LangChain 的 BaseMessage,需要时由
 * `langgraph-agent.ts:toLangChainMessage` 做转换。
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
    role: 'assistant'
    content: string | null
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
  }
  | { role: 'tool'; tool_call_id: string; content: string }

/**
 * 反问续答时,前端把用户对 interrupt 的回复打成 ResumeItem 数组传回来。
 * 配合 `[ASK_USER]` 协议 + 未来 LangGraph 原生 `Command(resume)`。
 */
export type ResumeItem = {
  interruptId: string
  status: 'resolved' | 'cancelled'
  payload?: Record<string, unknown>
}
