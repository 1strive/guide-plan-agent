/**
 * Task 4.5 — ask_user 工具：LangGraph 原生 interrupt 实现
 *
 * 规划:docs/开发规划.md Task 4.5（LangGraph 原生 interrupt 升级）
 * 八股:02-核心框架.md §6 LangGraph 状态机 / interrupt 机制
 *       04-工具调用.md §4 Human-in-the-Loop
 *
 * 设计要点:
 * - 使用 LangGraph 原生 interrupt() 函数，而非旧的 [ASK_USER] 文本协议
 * - 当 Agent 认为信息不足时，调用此工具 → interrupt() 暂停图执行
 * - Checkpoint 保存暂停状态，支持跨会话恢复
 * - 用户回复后通过 Command(resume=answer) 恢复，interrupt() 返回用户答案作为工具结果
 * - Agent 拿到用户回答后继续推理（同一个 Run 的两个阶段）
 */

import { interrupt } from '@langchain/langgraph'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'

/**
 * ask_user 工具 — 向用户提问并等待回复
 *
 * 内部调用 LangGraph interrupt()：
 * 1. 首次执行：interrupt(payload) 抛出 GraphInterrupt → 图暂停 → checkpoint 持久化
 * 2. 恢复执行：Command(resume=answer) → interrupt() 返回 answer → 工具返回结果给 Agent
 *
 * 八股 04 §4.1: interrupt 前的代码会在 resume 时重跑（节点重入），
 * 本工具函数体仅有 interrupt() 调用，天然幂等。
 */
export const askUserTool = tool(
    async (input: { question: string; options?: string[] }) => {
        // interrupt() 暂停图并将 payload 传递给调用方
        // resume 时此处返回用户的回答（string）
        const answer = interrupt({
            question: input.question,
            options: input.options ?? []
        })
        // answer 是 Command(resume=...) 传入的值
        return typeof answer === 'string' ? answer : JSON.stringify(answer)
    },
    {
        name: 'ask_user',
        description: '当信息不足以给出有效建议时（例如缺少目的地偏好、预算、出行时间、旅行风格等关键信息），使用此工具向用户提问获取更多信息。一次只问1-2个关键问题，并提供2-5个简短选项供选择。',
        schema: z.object({
            question: z.string().describe('要向用户提出的问题，应简洁聚焦'),
            options: z.array(z.string()).optional().describe('可选的预设选项列表(2-5个，每个2-6字)')
        })
    }
)
