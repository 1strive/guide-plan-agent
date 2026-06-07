/**
 * Task 4.3 — 记忆分层：对话摘要 + 用户画像
 *
 * 规划:docs/开发规划.md Task 4.3
 * 八股:05-记忆系统.md §长期记忆(语义摘要 = semantic memory 的工程形态)
 *
 * 设计要点:
 * - Run 完成后 fire-and-forget 调 maybeUpdateMemory,不阻塞 finalize
 * - 增量更新:有旧摘要时在其基础上更新(新信息覆盖旧信息)
 * - shouldSummarize 是纯函数,可独立测试
 */

import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import type { ChatMessage } from './llm.js'
import { buildChatModel } from './langgraph-agent.js'
import { getSessionSummary, updateSessionSummary } from '../db/chatRepo.js'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

const SUMMARY_SYSTEM_PROMPT = `你是对话记忆助手。请从以下对话历史中提取用户的旅行偏好和关键信息,生成简洁的摘要。

提取维度:
- 出发城市/常驻城市
- 偏好的旅行风格(自然风光/人文/美食/休闲等)
- 预算倾向
- 出行时间偏好(季节/天数)
- 同行人群(亲子/情侣/独行等)
- 已提及的目的地及态度(喜欢/不喜欢)
- 特殊需求(无障碍/饮食禁忌等)

规则:
1. 只输出摘要,不要解释或评论
2. 用简洁中文,不超过 300 字
3. 如果某个维度无信息,跳过即可
4. 如果有之前的摘要,在其基础上更新(新信息覆盖旧信息,无新信息保留旧信息)`

export function shouldSummarize(
  messageCount: number,
  threshold: number,
  existingSummary: string | null
): boolean {
  if (messageCount < threshold) return false
  // 首次摘要:消息数达到阈值
  if (existingSummary === null) return true
  // 后续更新:每半个阈值增量一次
  const halfThreshold = Math.max(Math.floor(threshold / 2), 1)
  return messageCount % halfThreshold === 0
}

export async function generateSummary(
  config: AppConfig,
  messages: ChatMessage[],
  existingSummary: string | null
): Promise<string> {
  const model = buildChatModel(config)

  const conversationText = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
    .join('\n')

  const humanContent = existingSummary
    ? `之前的摘要:\n${existingSummary}\n\n最新对话历史:\n${conversationText}`
    : `对话历史:\n${conversationText}`

  const result = await model.invoke([
    new SystemMessage(SUMMARY_SYSTEM_PROMPT),
    new HumanMessage(humanContent)
  ])

  return typeof result.content === 'string' ? result.content : ''
}

/**
 * Post-run 记忆更新入口。fire-and-forget,catch 所有异常不影响主流程。
 */
export async function maybeUpdateMemory(
  pool: DbPool,
  config: AppConfig,
  sessionId: string,
  messages: ChatMessage[],
  log: {
    info(obj: Record<string, unknown>, msg?: string): void
    error?(obj: Record<string, unknown>, msg?: string): void
  }
): Promise<void> {
  try {
    const existingSummary = await getSessionSummary(pool, sessionId)
    const messageCount = messages.filter(m => m.role === 'user' || m.role === 'assistant').length

    if (!shouldSummarize(messageCount, config.MEMORY_SUMMARY_THRESHOLD, existingSummary)) {
      return
    }

    const summary = await generateSummary(config, messages, existingSummary)
    await updateSessionSummary(pool, sessionId, summary)

    log.info(
      { sessionId, messageCount, messages, summaryLength: summary.length, isUpdate: existingSummary !== null },
      'memory summary generated'
    )
  } catch (err) {
    log.error?.({ sessionId, err: String(err) }, 'memory summary generation failed')
  }
}
