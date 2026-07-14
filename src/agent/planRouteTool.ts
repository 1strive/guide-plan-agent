/**
 * Task 4.5 衍生 — plan_route 工具：路线三要素纯工具 + MAP_ROUTE 渲染入口
 *
 * 规划:docs/开发规划.md Task 4.5 + 高德导航地图渲染改造（反问统一走 ask_user 重构）
 * 八股:04-工具调用.md §4 Human-in-the-Loop（反问由 ask_user 统一负责）
 *       04-工具调用.md §6 MCP 协议（路线数据由前端 AMap JS API 名称形式检索渲染）
 *
 * 设计要点:
 * - 路线渲染的唯一入口：Agent 抽取意图后调用此工具，带齐
 *   出发地 origin / 目的地 destinations[] / 出行方式 mode 三要素，直接返回 JSON
 * - 反问统一走 ask_user：本工具不再内置 interrupt() 槽位反问。缺出发地/出行方式/目的地时，
 *   模型应先用 ask_user 向用户反问补齐，信息齐备后再调用 plan_route（禁止传空）。
 *   这样「所有反问只有 ask_user 一条通道」，避免出现两条反问通道语义不一致
 * - 坐标解析交给前端：本工具只输出地点名称 + 城市，前端用 AMap
 *   名称形式 search([{keyword,city}...]) 让高德内部地理编码并绘制
 */

import { tool } from '@langchain/core/tools'
import { z } from 'zod'

/** 出行方式枚举（对齐 MapRouteEvent['mode'] / AMap 路线规划插件） */
const ROUTE_MODES = ['driving', 'walking', 'transit', 'bicycling'] as const
type RouteMode = (typeof ROUTE_MODES)[number]

/**
 * plan_route 工具 — 规划并渲染导航地图
 *
 * 纯工具：三要素齐备 → 返回 JSON，由 langgraphToAgUi 在 on_tool_end 拦截
 * 转成 MAP_ROUTE 事件下发前端。缺项的反问由 ask_user 在调用本工具之前完成。
 */
export const planRouteTool = tool(
    async (input: {
        origin: string
        destinations: string[]
        mode: RouteMode
        city?: string
        isLoop?: boolean
    }) => {
        // 三要素由调用方（模型）保证齐备：直接输出结构化路线意图，交给 adapter 转 MAP_ROUTE
        return JSON.stringify({
            origin: input.origin.trim(),
            destinations: input.destinations,
            mode: input.mode,
            city: input.city,
            isLoop: !!input.isLoop
        })
    },
    {
        name: 'plan_route',
        description:
            '规划并在前端渲染导航地图。当用户询问路线（如「从A到B怎么走/怎么去」），或你在规划行程、推荐游玩路线而涉及地点间移动时调用。调用前必须已确定出发地 origin、目的地 destinations（按游玩顺序）与出行方式 mode 三要素；若任一项未知，先用 ask_user 向用户反问补齐，信息齐备后再调用本工具，禁止传空值。【重要】origin 与 destinations 必须是高德地图能搜到的具体地点（城市/区县/景区/地标/详细地址），不能是「西北大环线」「川西小环线」这类抽象路线名；遇到这类命名路线或包含多个景点的行程，必须拆成按顺序排列的具体站点（如西宁、青海湖、茶卡盐湖等）填入 destinations。',
        schema: z.object({
            origin: z
                .string()
                .min(1)
                .describe('出发地名称，必须是高德能搜到的具体地点（如「北京站」「西宁」）。必填且非空；若用户未提供，先用 ask_user 反问，不要传空字符串。'),
            destinations: z
                .array(z.string())
                .min(1)
                .describe('一个或多个目的地名称，按游玩/途经顺序排列。【必须是高德能地理编码的具体地点】如城市/区县/景区/地标（青海湖、茶卡盐湖、莫高窟…）；绝不能填「西北大环线」这类抽象路线名。命名路线/多日行程请拆成有序的多个具体站点。'),
            mode: z
                .enum(ROUTE_MODES)
                .describe(
                    '出行方式（必填）：driving 驾车 / transit 公交 / walking 步行 / bicycling 骑行。能从意图判断就填（自驾/露营→driving，地铁/公交→transit，骑行→bicycling，步行→walking）；无法判断时先用 ask_user 反问，不要留空。'
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
