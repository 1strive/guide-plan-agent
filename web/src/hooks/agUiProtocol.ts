/**
 * AG-UI 事件协议统一解析核心（处理器注册表 + 归约状态 + 实时消费插件）
 *
 * 背景：consumeStream(实时流) 与 reduceAgUiEvents(会话恢复批量归约) 原本各写一套
 *       `event.type` switch，归约逻辑重复且容易漂移。此模块把「协议归约」抽成可注册的
 *       handler 表，两条路径共用同一份 source of truth；实时流特有的副作用
 *       (刷 store / 记录 runId / 错误 UI) 通过 AgUiStreamPlugin 插件化注入。
 *
 * 规划：AG-UI 协议统一解析架构原则（前端协议解析双路径设计）
 */

import type {
    AgUiEvent,
    ChatMsg,
    InterruptInfo,
    InterruptQuestion,
    MapRouteData,
    ToolCallInfo,
} from '../types'

/** 协议归约的可变状态：所有 handler 就地修改它 */
export interface ReduceState {
    content: string
    thinking: string
    toolCalls: ToolCallInfo[]
    /** 高德 MCP 路径规划结果（后端解析后下发，前端据此渲染导航地图） */
    mapRoutes: MapRouteData[]
    /** 归入最终消息的中断信息 */
    interrupt?: InterruptInfo
    /** 需要抬到全局 store 的中断信息（仅实时插件消费） */
    pendingInterrupt: InterruptInfo | null
    /** RUN_STARTED 携带的 runId（仅实时插件消费，批量归约忽略） */
    runId?: string
}

export function createReduceState(): ReduceState {
    return {
        content: '',
        thinking: '',
        toolCalls: [],
        mapRoutes: [],
        interrupt: undefined,
        pendingInterrupt: null,
        runId: undefined,
    }
}

/** 单个事件类型的归约处理器：就地修改 state */
export type ProtocolHandler = (state: ReduceState, event: AgUiEvent) => void

/** 协议归约条目：when=触发的事件类型（执行时机），action=就地归约动作（执行动作） */
export interface ProtocolHandlerEntry {
    when: string
    action: ProtocolHandler
}

/** 按 event.type 查表分发；未注册的事件类型静默忽略 */
export function applyAgUiEvent(state: ReduceState, event: AgUiEvent): void {
    registry.get(event.type)?.(state, event)
}

/** 从归约状态产出最终 assistant 消息 */
export function toChatMsg(state: ReduceState): ChatMsg {
    return {
        role: 'assistant',
        content: state.content,
        thinking: state.thinking || undefined,
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
        interrupt: state.interrupt,
        mapRoutes: state.mapRoutes.length > 0 ? state.mapRoutes : undefined,
    }
}

// ─── 解析辅助 ───

type RawQuestion = { id: string; message: string; reason: string; options?: string[] }
type RawInterrupt = {
    id: string
    message?: string
    reason: string
    metadata?: { options?: string[] }
}

function parseQuestions(raw: RawQuestion[] | undefined): InterruptQuestion[] {
    if (!raw?.length) return []
    return raw.map((q) => ({ id: q.id, message: q.message, reason: q.reason, options: q.options }))
}

// ─── 内置协议处理器注册表（数组形式，与 note-05-AG-UI协议文档.md 事件列表对齐）───

/** 所有内置协议归约条目集中于此数组，每项 = { when 执行时机, action 执行动作 } */
const protocolHandlers: ProtocolHandlerEntry[] = [
    {
        when: 'RUN_STARTED',
        action: (state, event) => {
            state.runId = event.runId as string
        },
    },
    {
        when: 'TEXT_MESSAGE_CONTENT',
        action: (state, event) => {
            state.content += event.delta as string
        },
    },
    {
        when: 'THINKING_CONTENT',
        action: (state, event) => {
            state.thinking += event.delta as string
        },
    },
    {
        when: 'TOOL_CALL_START',
        action: (state, event) => {
            state.toolCalls.push({ name: event.toolCallName as string, status: 'running' })
        },
    },
    {
        when: 'TOOL_CALL_END',
        action: (state) => {
            const running = state.toolCalls.find((t) => t.status === 'running')
            if (running) running.status = 'done'
        },
    },
    {
        when: 'RUN_ERROR',
        action: (state, event) => {
            state.content += `\n[错误] ${event.message}`
        },
    },
    {
        // ASK_USER：一等中断事件，直接携带问题数据
        when: 'ASK_USER',
        action: (state, event) => {
            const questions = parseQuestions(event.questions as RawQuestion[] | undefined)
            if (questions.length) {
                state.interrupt = { questions }
                state.pendingInterrupt = { questions }
                // ASK_USER 时用首个问题文本作为显示内容
                state.content = questions[0]?.message ?? ''
            }
        },
    },
    {
        // RUN_FINISHED：仅在前面没有 ASK_USER 时兼容旧协议 outcome.interrupt
        when: 'RUN_FINISHED',
        action: (state, event) => {
            if (state.interrupt) return
            const outcome = event.outcome as
                | { type: string; interrupts?: RawInterrupt[] }
                | undefined
            if (outcome?.type === 'interrupt' && outcome.interrupts?.length) {
                const questions: InterruptQuestion[] = outcome.interrupts.map((it) => ({
                    id: it.id,
                    message: it.message ?? '',
                    reason: it.reason,
                    options: it.metadata?.options,
                }))
                state.interrupt = { questions }
                state.pendingInterrupt = { questions }
                state.content = questions[0]?.message ?? ''
            }
        },
    },
    {
        /**
         * MAP_ROUTE：后端识别高德 MCP 路径规划工具的结果后下发的路线数据
         * 前端据此渲染可交互导航地图（详见 Conversation/RouteMapView.tsx）
         *
         * Task — 高德导航地图渲染 Task 5
         * 八股：04-工具调用.md §6 MCP 协议
         */
        when: 'MAP_ROUTE',
        action: (state, event) => {
            const data = event as unknown as MapRouteData & { type: string }
            if (!Array.isArray(data.path) || data.path.length < 2) return
            state.mapRoutes.push({
                mode: data.mode,
                origin: data.origin,
                destination: data.destination,
                path: data.path,
                distanceMeters: data.distanceMeters,
                durationSeconds: data.durationSeconds,
                originName: data.originName,
                destinationName: data.destinationName,
                // 透传 city：前端公交（AMap.Transfer）规划构造必填，缺失会退化
                city: data.city,
            })
        },
    },
]

/** 由条目数组构建查表用的分发注册表（when → action） */
const registry = new Map<string, ProtocolHandler>(
    protocolHandlers.map((h) => [h.when, h.action]),
)

/** 注册/覆盖某事件类型的归约处理器（对外开放，便于扩展新协议事件） */
export function registerProtocolHandler(type: string, handler: ProtocolHandler): void {
    registry.set(type, handler)
}

// ─── 实时消费插件 ───

/**
 * 实时流消费插件：仅在对话流实时进行时才需要的副作用（刷 store、记 runId、错误 UI）。
 * 批量归约路径(reduceAgUiEvents)不装载任何插件。
 */
export interface AgUiStreamPlugin {
    /** 每个事件归约后触发 */
    onEvent?(event: AgUiEvent, state: Readonly<ReduceState>): void
    /** 流正常结束后触发 */
    onFinish?(state: Readonly<ReduceState>): void
    /** 流抛错时触发（含 AbortError，由插件自行判断是否忽略） */
    onError?(error: Error, state: Readonly<ReduceState>): void
}

/**
 * 通用事件驱动循环：归约 + 分发插件。
 * 异常先经插件 onError，再向上冒泡交给调用方处理连接层收尾。
 */
export async function consumeAgUiStream(
    stream: AsyncGenerator<AgUiEvent>,
    plugins: AgUiStreamPlugin[],
): Promise<ReduceState> {
    const state = createReduceState()
    try {
        for await (const event of stream) {
            applyAgUiEvent(state, event)
            for (const p of plugins) p.onEvent?.(event, state)
        }
    } catch (e) {
        for (const p of plugins) p.onError?.(e as Error, state)
        throw e
    }
    for (const p of plugins) p.onFinish?.(state)
    return state
}
