/**
 * Task 4.5 衍生 — plan_route 工具：路线三要素槽位填充 + 原生 interrupt 反问
 *
 * 规划:docs/开发规划.md Task 4.5（LangGraph 原生 interrupt）+ 高德导航地图渲染改造
 * 八股:04-工具调用.md §4 Human-in-the-Loop（interrupt 反问）
 *       04-工具调用.md §6 MCP 协议（路线数据由前端 AMap JS API 名称形式检索渲染）
 *
 * 设计要点:
 * - 路线渲染的唯一入口：Agent 抽取意图后调用此工具，显式产出
 *   出发地 origin / 目的地 destinations[] / 出行方式 mode 三要素
 * - 确定性反问：origin 为空 → interrupt 问出发地；mode 为空 → interrupt 问出行方式。
 *   反问行为不依赖 LLM 自觉，天然满足「缺项必反问」需求
 * - 坐标解析交给前端：本工具只输出地点名称 + 城市，前端用 AMap
 *   名称形式 search([{keyword,city}...]) 让高德内部地理编码并绘制
 * - 节点重入幂等：resume 时函数从头重跑，首个未满足的 interrupt() 返回用户答案；
 *   origin、mode 双缺时经两次 resume 顺序补齐（现有 detectInterrupt 循环支持）
 */

import { interrupt } from '@langchain/langgraph'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'

/** 出行方式枚举（对齐 MapRouteEvent['mode'] / AMap 路线规划插件） */
const ROUTE_MODES = ['driving', 'walking', 'transit', 'bicycling'] as const
type RouteMode = (typeof ROUTE_MODES)[number]

/** 反问出行方式时的中文标签 → mode 映射（含常见近义词兜底） */
const LABEL_TO_MODE: Record<string, RouteMode> = {
    驾车: 'driving',
    开车: 'driving',
    自驾: 'driving',
    公交: 'transit',
    地铁: 'transit',
    公共交通: 'transit',
    步行: 'walking',
    走路: 'walking',
    骑行: 'bicycling',
    骑车: 'bicycling'
}

/**
 * plan_route 工具 — 规划并渲染导航地图
 *
 * 内部用 LangGraph interrupt() 做槽位反问（同 askUserTool 机制）：
 * 1. origin 为空 → 暂停问「从哪里出发」
 * 2. mode 为空 → 暂停问「哪种出行方式」（4 选项）
 * 3. 三要素齐备 → 返回 JSON，由 langgraphToAgUi 拦截转成 MAP_ROUTE 事件下发前端
 */
export const planRouteTool = tool(
    async (input: {
        origin: string
        destinations: string[]
        mode?: RouteMode
        city?: string
        isLoop?: boolean
    }) => {
        // 槽位 1：出发地缺失 → interrupt 反问（resume 时此处返回用户答案）
        let origin = input.origin
        if (!origin || !origin.trim()) {
            const answer = interrupt({ question: '请问您从哪里出发？', options: [] })
            origin = typeof answer === 'string' ? answer : JSON.stringify(answer)
        }

        // 槽位 2：出行方式缺失 → interrupt 反问（4 选项），标签映射回 mode
        let mode = input.mode
        if (!mode) {
            const answer = interrupt({
                question: '您希望用哪种出行方式？',
                options: ['驾车', '公交', '步行', '骑行']
            })
            const label = (typeof answer === 'string' ? answer : '').trim()
            mode = LABEL_TO_MODE[label] ?? 'driving' // 无法识别时兜底驾车
        }

        // 三要素齐备：输出结构化路线意图，交给 adapter 转 MAP_ROUTE
        return JSON.stringify({
            origin: origin.trim(),
            destinations: input.destinations,
            mode,
            city: input.city,
            isLoop: !!input.isLoop
        })
    },
    {
        name: 'plan_route',
        description:
            '规划并在前端渲染导航地图。当用户询问路线（如「从A到B怎么走/怎么去」），或你在规划行程、推荐游玩路线而涉及地点间移动时调用。传入出发地、一个或多个目的地（按游玩顺序）、出行方式。出发地未知时传空字符串、出行方式无法从意图判断时留空，工具会自动向用户反问。',
        schema: z.object({
            origin: z
                .string()
                .describe('出发地名称（如「北京站」）。若无法从用户意图确定，传空字符串，工具会反问用户。'),
            destinations: z
                .array(z.string())
                .min(1)
                .describe('一个或多个目的地名称，按游玩/途经顺序排列（多目的地或环线时填多个）。'),
            mode: z
                .enum(ROUTE_MODES)
                .optional()
                .describe(
                    '出行方式：driving 驾车 / transit 公交 / walking 步行 / bicycling 骑行。能从意图判断就填（自驾/露营→driving，地铁/公交→transit，骑行→bicycling，步行→walking），无法判断则留空，工具会反问用户。'
                ),
            city: z
                .string()
                .optional()
                .describe('地点所在城市（如「北京」）。公交（transit）必填，其余方式建议填以消歧。'),
            isLoop: z
                .boolean()
                .optional()
                .describe('是否为环线（终点回到出发地），如「西北大环线」。默认 false。')
        })
    }
)
