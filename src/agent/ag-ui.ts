import { randomUUID } from 'node:crypto'
import type { TokenUsage } from './token-usage.js'

// ─── EventType 枚举 ───
// 与 @ag-ui/core EventType 完全对齐
export enum EventType {
    // Lifecycle
    RUN_STARTED = 'RUN_STARTED',
    RUN_FINISHED = 'RUN_FINISHED',
    RUN_ERROR = 'RUN_ERROR',
    STEP_STARTED = 'STEP_STARTED',
    STEP_FINISHED = 'STEP_FINISHED',
    // Text Message
    TEXT_MESSAGE_START = 'TEXT_MESSAGE_START',
    TEXT_MESSAGE_CONTENT = 'TEXT_MESSAGE_CONTENT',
    TEXT_MESSAGE_END = 'TEXT_MESSAGE_END',
    // Tool Call
    TOOL_CALL_START = 'TOOL_CALL_START',
    TOOL_CALL_ARGS = 'TOOL_CALL_ARGS',
    TOOL_CALL_END = 'TOOL_CALL_END',
    TOOL_CALL_RESULT = 'TOOL_CALL_RESULT',
    // Task 4.1:思考过程独立化(MiniMax 等模型把 <think>...</think> 内联 content 时,adapter 拆出来发独立事件)
    THINKING_START = 'THINKING_START',
    THINKING_CONTENT = 'THINKING_CONTENT',
    THINKING_END = 'THINKING_END',
    // Task 4.2:Plan-and-Execute 模式 — 规划阶段产出的步骤计划(JSON);前端可选渲染,持久化便于 trace
    PLAN_GENERATED = 'PLAN_GENERATED',
}

// ─── Base Event ───
export type BaseEvent = {
    type: EventType
    timestamp?: number
}

// ─── Lifecycle Events ───
export type RunStartedEvent = BaseEvent & {
    type: EventType.RUN_STARTED
    threadId: string
    runId: string
}

// ─── Interrupt 类型 ───
export type Interrupt = {
    id: string
    reason: string
    message?: string
    toolCallId?: string
    responseSchema?: Record<string, unknown>
    metadata?: Record<string, unknown>
}

export type RunFinishedOutcome =
    | { type: 'success' }
    | { type: 'interrupt'; interrupts: Interrupt[] }

// Task 4.4:通用工具来源标签(MCP 工具动态发现,不再绑定特定工具名)
export type Source = {
    type: string
    name: string
    metadata: Record<string, unknown>
}

export type RunFinishedEvent = BaseEvent & {
    type: EventType.RUN_FINISHED
    threadId: string
    runId: string
    outcome?: RunFinishedOutcome
    usage?: TokenUsage
    // Task 3.5:本次 Run 引用过的所有目的地来源(已按 destinationId 去重)
    sources?: Source[]
}

export type RunErrorEvent = BaseEvent & {
    type: EventType.RUN_ERROR
    message: string
    code?: string
}

export type StepStartedEvent = BaseEvent & {
    type: EventType.STEP_STARTED
    stepName: string
}

export type StepFinishedEvent = BaseEvent & {
    type: EventType.STEP_FINISHED
    stepName: string
}

// ─── Text Message Events ───
export type TextMessageStartEvent = BaseEvent & {
    type: EventType.TEXT_MESSAGE_START
    messageId: string
    role: 'assistant'
}

export type TextMessageContentEvent = BaseEvent & {
    type: EventType.TEXT_MESSAGE_CONTENT
    messageId: string
    delta: string
}

export type TextMessageEndEvent = BaseEvent & {
    type: EventType.TEXT_MESSAGE_END
    messageId: string
}

// ─── Tool Call Events ───
export type ToolCallStartEvent = BaseEvent & {
    type: EventType.TOOL_CALL_START
    toolCallId: string
    toolCallName: string
}

export type ToolCallArgsEvent = BaseEvent & {
    type: EventType.TOOL_CALL_ARGS
    toolCallId: string
    delta: string
}

export type ToolCallEndEvent = BaseEvent & {
    type: EventType.TOOL_CALL_END
    toolCallId: string
}

export type ToolCallResultEvent = BaseEvent & {
    type: EventType.TOOL_CALL_RESULT
    messageId: string
    toolCallId: string
    content: string
    role?: 'tool'
}

// ─── Plan Events(Task 4.2) ───
// Plan-and-Execute 模式规划阶段输出。每个 step 对应执行阶段的 1 次 runTool 调用。
// 后续阶段的 TOOL_CALL_* / TEXT_MESSAGE_* 事件跟 ReAct 完全一致,前端 0 改动。
export type PlanStep = {
    id: string
    goal: string
    tool: string                  // 工具名(必须是已注册工具)
    args: Record<string, unknown> // 工具参数(完整值,不支持引用前一步)
}

export type PlanGeneratedEvent = BaseEvent & {
    type: EventType.PLAN_GENERATED
    plan: {
        rationale: string
        steps: PlanStep[]
    }
}

// ─── Thinking Events(Task 4.1) ───
// 跟 TextMessage 完全平行:模型 reasoning 过程作为独立事件流,前端可折叠显示。
// messageId 跟同轮的 TextMessage 不同 id;同 runId 内可能出现多次 START/END 对(交错)。
export type ThinkingStartEvent = BaseEvent & {
    type: EventType.THINKING_START
    messageId: string
}

export type ThinkingContentEvent = BaseEvent & {
    type: EventType.THINKING_CONTENT
    messageId: string
    delta: string
}

export type ThinkingEndEvent = BaseEvent & {
    type: EventType.THINKING_END
    messageId: string
}

// ─── Event Union ───
export type AgUiEvent =
    | RunStartedEvent
    | RunFinishedEvent
    | RunErrorEvent
    | StepStartedEvent
    | StepFinishedEvent
    | TextMessageStartEvent
    | TextMessageContentEvent
    | TextMessageEndEvent
    | ToolCallStartEvent
    | ToolCallArgsEvent
    | ToolCallEndEvent
    | ToolCallResultEvent
    | ThinkingStartEvent
    | ThinkingContentEvent
    | ThinkingEndEvent
    | PlanGeneratedEvent

// ─── 事件构造辅助函数 ───
const ts = () => Date.now()

export function createRunStarted(threadId: string, runId: string): RunStartedEvent {
    return { type: EventType.RUN_STARTED, threadId, runId, timestamp: ts() }
}

export function createRunFinished(
    threadId: string,
    runId: string,
    outcome?: RunFinishedOutcome,
    usage?: TokenUsage,
    sources?: Source[]
): RunFinishedEvent {
    return { type: EventType.RUN_FINISHED, threadId, runId, outcome, usage, sources, timestamp: ts() }
}

export function createInterrupt(
    reason: string,
    message?: string,
    opts?: { toolCallId?: string; responseSchema?: Record<string, unknown>; metadata?: Record<string, unknown> }
): Interrupt {
    return {
        id: randomUUID(),
        reason,
        message,
        toolCallId: opts?.toolCallId,
        responseSchema: opts?.responseSchema,
        metadata: opts?.metadata
    }
}

export function createRunError(message: string, code?: string): RunErrorEvent {
    return { type: EventType.RUN_ERROR, message, code, timestamp: ts() }
}

export function createStepStarted(stepName: string): StepStartedEvent {
    return { type: EventType.STEP_STARTED, stepName, timestamp: ts() }
}

export function createStepFinished(stepName: string): StepFinishedEvent {
    return { type: EventType.STEP_FINISHED, stepName, timestamp: ts() }
}

export function createTextMessageStart(messageId: string): TextMessageStartEvent {
    return { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant', timestamp: ts() }
}

export function createTextMessageContent(messageId: string, delta: string): TextMessageContentEvent {
    return { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta, timestamp: ts() }
}

export function createTextMessageEnd(messageId: string): TextMessageEndEvent {
    return { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: ts() }
}

export function createToolCallStart(toolCallId: string, toolCallName: string): ToolCallStartEvent {
    return { type: EventType.TOOL_CALL_START, toolCallId, toolCallName, timestamp: ts() }
}

export function createToolCallArgs(toolCallId: string, delta: string): ToolCallArgsEvent {
    return { type: EventType.TOOL_CALL_ARGS, toolCallId, delta, timestamp: ts() }
}

export function createToolCallEnd(toolCallId: string): ToolCallEndEvent {
    return { type: EventType.TOOL_CALL_END, toolCallId, timestamp: ts() }
}

export function createToolCallResult(
    toolCallId: string,
    content: string
): ToolCallResultEvent {
    return {
        type: EventType.TOOL_CALL_RESULT,
        messageId: randomUUID(),
        toolCallId,
        content,
        role: 'tool',
        timestamp: ts()
    }
}

// ─── Thinking 构造器(Task 4.1) ───
export function createThinkingStart(messageId: string): ThinkingStartEvent {
    return { type: EventType.THINKING_START, messageId, timestamp: ts() }
}

export function createThinkingContent(messageId: string, delta: string): ThinkingContentEvent {
    return { type: EventType.THINKING_CONTENT, messageId, delta, timestamp: ts() }
}

export function createThinkingEnd(messageId: string): ThinkingEndEvent {
    return { type: EventType.THINKING_END, messageId, timestamp: ts() }
}

// ─── Plan 构造器(Task 4.2) ───
export function createPlanGenerated(plan: PlanGeneratedEvent['plan']): PlanGeneratedEvent {
    return { type: EventType.PLAN_GENERATED, plan, timestamp: ts() }
}
