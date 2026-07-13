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
    // Task 4.1：思考过程独立化(MiniMax 等模型把 <think>...</think> 内联 content 时,adapter 拆出来发独立事件)
    THINKING_START = 'THINKING_START',
    THINKING_CONTENT = 'THINKING_CONTENT',
    THINKING_END = 'THINKING_END',
    // ASK_USER：Agent 主动向用户提问（独立一等事件，替代 RUN_FINISHED.outcome.interrupt 携带问题数据）
    ASK_USER = 'ASK_USER',
    // MAP_ROUTE：路线规划结果（后端识别高德 MCP 路径规划工具的输出，解析出折线/起终点/距离耗时）
    // 前端据此用 AMap JS API 渲染可交互导航地图（详见 web/src/Conversation/RouteMapView.tsx）
    MAP_ROUTE = 'MAP_ROUTE',
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

// ─── Thinking Events（Task 4.1）───
// 跟 TextMessage 完全平行：模型 reasoning 过程作为独立事件流，前端可折叠显示。
// messageId 跟同轮的 TextMessage 不同 id；同 runId 内可能出现多次 START/END 对（交错）。
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

// ─── ASK_USER Event ───
// Agent 主动向用户提问：携带问题文本和可选选项，前端据此渲染 AskCard。
// 紧跟其后会有 RUN_FINISHED(outcome='interrupt') 标志 Run 挂起。
export type AskUserEvent = BaseEvent & {
    type: EventType.ASK_USER
    messageId: string
    questions: Array<{
        id: string
        message: string
        reason: string
        options?: string[]
    }>
}

// ─── MAP_ROUTE Event ───
// 由 plan_route 工具下发：Agent 抽取出发地/目的地/出行方式三要素后，
// adapter 组装成有序 points（名称形式）下发前端；前端用 AMap JS API
// 名称形式检索渲染交互地图，支持多目的地与环线。
// 八股 04 §6 MCP 协议：坐标解析交给前端 AMap JS API，后端只传地点名称 + 城市
export type MapRouteEvent = BaseEvent & {
    type: EventType.MAP_ROUTE
    messageId: string
    /** 出行方式：driving=驾车 walking=步行 transit=公交 bicycling=骑行 */
    mode: 'driving' | 'walking' | 'transit' | 'bicycling'
    /**
     * 有序路线点（名称形式，主路径）：首=起点、末=终点、中间=途经点。
     * 由 plan_route 工具下发，前端用 AMap 名称形式 search([{keyword,city}...]) 渲染。
     */
    points?: Array<{ name: string; city?: string }>
    /** 是否环线（终点回到起点），如「西北大环线」；true 时前端在末尾补回起点 */
    isLoop?: boolean
    /** 起点坐标 [lng, lat]（坐标形式，兜底/兼容） */
    origin?: [number, number]
    /** 终点坐标 [lng, lat]（坐标形式，兜底/兼容） */
    destination?: [number, number]
    /** 折线坐标点（坐标形式兜底；名称形式下由前端插件现算，可为空） */
    path?: Array<[number, number]>
    /** 全程距离（米） */
    distanceMeters?: number
    /** 全程耗时（秒） */
    durationSeconds?: number
    /** 起点/终点显示名称（便于地图标注） */
    originName?: string
    destinationName?: string
    /** 公交换乘城市（AMap.Transfer 构造必填），从工具入参解析下发 */
    city?: string
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
    | AskUserEvent
    | MapRouteEvent

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

// ─── ASK_USER 构造器 ───
export function createAskUser(
    messageId: string,
    questions: AskUserEvent['questions']
): AskUserEvent {
    return { type: EventType.ASK_USER, messageId, questions, timestamp: ts() }
}

// ─── MAP_ROUTE 构造器 ───
export function createMapRoute(
    messageId: string,
    mode: MapRouteEvent['mode'],
    path: MapRouteEvent['path'],
    opts?: {
        points?: Array<{ name: string; city?: string }>
        isLoop?: boolean
        origin?: [number, number]
        destination?: [number, number]
        originName?: string
        destinationName?: string
        distanceMeters?: number
        durationSeconds?: number
        city?: string
    }
): MapRouteEvent {
    return {
        type: EventType.MAP_ROUTE,
        messageId,
        mode,
        path,
        points: opts?.points,
        isLoop: opts?.isLoop,
        origin: opts?.origin,
        destination: opts?.destination,
        originName: opts?.originName,
        destinationName: opts?.destinationName,
        distanceMeters: opts?.distanceMeters,
        durationSeconds: opts?.durationSeconds,
        city: opts?.city,
        timestamp: ts()
    }
}

