import { randomUUID } from 'node:crypto'

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

export type RunFinishedEvent = BaseEvent & {
    type: EventType.RUN_FINISHED
    threadId: string
    runId: string
    outcome?: RunFinishedOutcome
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

// ─── 事件构造辅助函数 ───
const ts = () => Date.now()

export function createRunStarted(threadId: string, runId: string): RunStartedEvent {
    return { type: EventType.RUN_STARTED, threadId, runId, timestamp: ts() }
}

export function createRunFinished(threadId: string, runId: string, outcome?: RunFinishedOutcome): RunFinishedEvent {
    return { type: EventType.RUN_FINISHED, threadId, runId, outcome, timestamp: ts() }
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
