/**
 * AG-UI 事件流批量归约（会话恢复路径）
 *
 * 薄封装 agUiProtocol 的注册表核心：把原始 AG-UI 事件数组归约为 ChatMsg 状态。
 * 与实时流 consumeStream 共用同一份 handler 表，二者语义严格一致、无副作用、无 store 依赖。
 *
 * 用途：会话恢复路径（Sidebar switchSession 拿到 lastRunEvents 后批量归约）
 *
 * 规划：AG-UI 协议统一解析架构原则
 */

import type { AgUiEvent, ChatMsg, InterruptInfo } from '../types'
import { applyAgUiEvent, createReduceState, toChatMsg } from './agUiProtocol'

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
    const state = createReduceState()
    for (const event of events) applyAgUiEvent(state, event)
    return { message: toChatMsg(state), pendingInterrupt: state.pendingInterrupt }
}
