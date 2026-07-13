// ─── 后端 API 响应类型 ───

export type SessionItem = {
  id: string
  title: string | null
  totalTokens: number
  createdAt: string
  /** Sidebar 设计稿对齐：最近一条消息内容（任意 role），用于会话项 preview 行 */
  lastMessage: string | null
  /** Sidebar 设计稿对齐：user+assistant 消息数，用于会话项 badge */
  messageCount: number
}

export type ChatMsgItem = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type SessionStatus = 'running' | 'end'

export type AgentRunRow = {
  runId: string
  sessionId: string
  status: 'pending' | 'running' | 'completed' | 'interrupted' | 'cancelling' | 'cancelled' | 'failed'
  startedAt: string
  finishedAt: string | null
  lastEventSeq: number
  totalTokens: number
}

export type ResumeItem = {
  interruptId: string
  status: 'resolved' | 'cancelled'
  payload?: Record<string, unknown>
}

export type AgUiEvent = {
  type: string
  [key: string]: unknown
}

// ─── 前端 UI 模型 ───

export type ToolCallInfo = {
  name: string
  status: 'running' | 'done'
}

/** 单条中断问题（对应后端 Interrupt 对象） */
export type InterruptQuestion = {
  id: string
  message: string
  reason: string
  options?: string[]
}

/**
 * 中断信息聚合：支持多问题纵向展开
 * - 未回答：questions 全部展示选项
 * - 已回答：仅显示 selectedAnswer
 */
export type InterruptInfo = {
  questions: InterruptQuestion[]
  selectedAnswer?: string
}

export type ChatMsg = {
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  toolCalls?: ToolCallInfo[]
  interrupt?: InterruptInfo
  quickReplies?: string[]
  /** 高德 MCP 路径规划结果（后端解析后下发，前端据此渲染导航地图） */
  mapRoutes?: MapRouteData[]
}

/** 高德路线规划结构化数据（用于地图渲染），由 plan_route 工具下发 */
export type MapRouteData = {
  mode: 'driving' | 'walking' | 'transit' | 'bicycling'
  /**
   * 有序路线点（名称形式，主路径）：首=起点、末=终点、中间=途经点。
   * 前端用 AMap 名称形式 search([{keyword,city}...]) 渲染，支持多目的地与环线。
   */
  points?: Array<{ name: string; city?: string }>
  /** 是否环线（终点回到起点） */
  isLoop?: boolean
  origin?: [number, number]
  destination?: [number, number]
  /** 折线坐标点（坐标形式兜底；名称形式下由前端插件现算，可为空） */
  path?: Array<[number, number]>
  distanceMeters?: number
  durationSeconds?: number
  originName?: string
  destinationName?: string
  /** 公交换乘所需城市（AMap.Transfer 构造必填） */
  city?: string
}
