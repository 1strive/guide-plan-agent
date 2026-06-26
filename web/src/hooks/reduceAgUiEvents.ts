/**
 * AG-UI 事件流归约纯函数
 *
 * 将原始 AG-UI 事件数组批量归约为 ChatMsg 状态。
 * 与 consumeStream 中的增量逻辑保持语义一致，但无副作用、无 store 依赖。
 *
 * 用途：
 * - 会话恢复路径：switchSession 拿到 lastRunEvents 后批量归约
 * - 未来可作为 consumeStream 内部逻辑的 source of truth
 *
 * 规划：AG-UI 协议统一解析架构原则
 */

import type { AgUiEvent, ChatMsg, InterruptInfo, InterruptQuestion, ToolCallInfo } from '../types'

export type ReduceResult = {
    /** 归约后的 assistant 消息（含 thinking/interrupt/toolCalls） */
    message: ChatMsg
    /** 全局中断状态（存入 store.pendingInterrupt） */
    pendingInterrupt: InterruptInfo | null
}

/**
 * 从 AG-UI 事件数组归约出最终 ChatMsg 状态
 * 事件顺序与 SSE 流一致：THINKING → TEXT → TOOL_CALL → ASK_USER → RUN_FINISHED
 */
export function reduceAgUiEvents(events: AgUiEvent[]): ReduceResult {
    let content = ''
    let thinking = ''
    const toolCalls: ToolCallInfo[] = []
    let interrupt: InterruptInfo | undefined
    let pendingInterrupt: InterruptInfo | null = null

    for (const event of events) {
        switch (event.type) {
            case 'TEXT_MESSAGE_CONTENT': {
                content += event.delta as string
                break
            }
            case 'THINKING_CONTENT': {
                thinking += event.delta as string
                break
            }
            case 'TOOL_CALL_START': {
                toolCalls.push({ name: event.toolCallName as string, status: 'running' })
                break
            }
            case 'TOOL_CALL_END': {
                const running = toolCalls.find((t) => t.status === 'running')
                if (running) running.status = 'done'
                break
            }
            case 'ASK_USER': {
                const rawQuestions = event.questions as Array<{
                    id: string
                    message: string
                    reason: string
                    options?: string[]
                }>
                if (rawQuestions?.length) {
                    const questions: InterruptQuestion[] = rawQuestions.map((q) => ({
                        id: q.id,
                        message: q.message,
                        reason: q.reason,
                        options: q.options,
                    }))
                    interrupt = { questions }
                    pendingInterrupt = { questions }
                    // ASK_USER 时用问题文本作为显示内容
                    content = questions[0]?.message ?? ''
                }
                break
            }
            case 'RUN_FINISHED': {
                // 兼容回退：若无 ASK_USER 事件但 outcome 里有 interrupt
                if (!interrupt) {
                    const outcome = event.outcome as
                        | {
                            type: string
                            interrupts?: Array<{
                                id: string
                                message?: string
                                reason: string
                                metadata?: { options?: string[] }
                            }>
                        }
                        | undefined
                    if (outcome?.type === 'interrupt' && outcome.interrupts?.length) {
                        const questions: InterruptQuestion[] = outcome.interrupts.map((it) => ({
                            id: it.id,
                            message: it.message ?? '',
                            reason: it.reason,
                            options: it.metadata?.options,
                        }))
                        interrupt = { questions }
                        pendingInterrupt = { questions }
                        content = questions[0]?.message ?? ''
                    }
                }
                break
            }
            case 'RUN_ERROR': {
                content += `\n[错误] ${event.message}`
                break
            }
        }
    }

    const message: ChatMsg = {
        role: 'assistant',
        content,
        thinking: thinking || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        interrupt,
    }

    return { message, pendingInterrupt }
}
