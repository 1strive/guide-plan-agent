/**
 * Task — 高德 MCP 路径规划结果解析
 *
 * 规划:docs/开发规划.md Task（高德导航地图渲染）
 * 八股:docs/01-面试八股文/04-工具调用.md §6 MCP 协议
 *
 * 设计要点:
 * - 高德 MCP 工具（maps_direction_driving/walking/transit_integrated、maps_bicycling）
 *   返回结构不可完全控制（MCP 可能包一层），必须防御性解析
 * - parseAmapRoute() 为纯函数，返回解析结果或 null；解析失败时上层只走正常 TOOL_CALL_RESULT 通道
 * - 不抛异常，不影响主事件流
 */

import type { MapRouteEvent } from './ag-ui.js'

/** 解析结果（前端渲染够用即可） */
export type AmapRouteParsed = {
    mode: MapRouteEvent['mode']
    origin?: [number, number]
    destination?: [number, number]
    path: Array<[number, number]>
    distanceMeters?: number
    durationSeconds?: number
    originName?: string
    destinationName?: string
}

/** 高德 MCP 路径规划工具名 → 出行方式 */
export const AMAP_ROUTE_TOOL_MODE: Record<string, MapRouteEvent['mode']> = {
    maps_direction_driving: 'driving',
    maps_direction_walking: 'walking',
    maps_direction_transit_integrated: 'transit',
    maps_bicycling: 'bicycling',
    // 兜底兼容：高德 MCP 后续若改名，追加映射即可
}

/** 是否高德路径规划工具 */
export function isAmapRouteTool(name: string): boolean {
    return name in AMAP_ROUTE_TOOL_MODE
}

/** 把 "lng,lat;lng,lat;..." 解析为 [lng,lat][] */
function parsePolyline(s: string): Array<[number, number]> {
    if (!s) return []
    return s
        .split(';')
        .map((p) => {
            const [lngStr, latStr] = p.split(',')
            const lng = Number(lngStr)
            const lat = Number(latStr)
            return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] as [number, number] : null
        })
        .filter((p): p is [number, number] => p !== null)
}

/** 把 "lng,lat" 或 {lng,lat} / [lng,lat] 解析为 [lng,lat] */
function parseCoord(v: unknown): [number, number] | undefined {
    if (typeof v === 'string') {
        const [lngStr, latStr] = v.split(',')
        const lng = Number(lngStr)
        const lat = Number(latStr)
        if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat]
    }
    if (Array.isArray(v) && v.length === 2) {
        const lng = Number(v[0])
        const lat = Number(v[1])
        if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat]
    }
    if (v && typeof v === 'object') {
        const obj = v as { location?: string; lng?: number; lat?: number }
        if (obj.location) return parseCoord(obj.location)
        const lng = obj.lng
        const lat = obj.lat
        if (typeof lng === 'number' && typeof lat === 'number' && Number.isFinite(lng) && Number.isFinite(lat)) {
            return [lng, lat]
        }
    }
    return undefined
}

/** 相邻点去重，避免 MCP 数据里 step 拼接出现重复坐标 */
function dedupeAdjacent(points: Array<[number, number]>): Array<[number, number]> {
    if (points.length === 0) return points
    const out: Array<[number, number]> = [points[0]!]
    for (let i = 1; i < points.length; i++) {
        const prev = out[out.length - 1]!
        const cur = points[i]!
        if (prev[0] !== cur[0] || prev[1] !== cur[1]) out.push(cur)
    }
    return out
}

/** 把 output（string | object）安全转成对象 */
function toObject(output: unknown): Record<string, unknown> | null {
    if (!output) return null
    if (typeof output === 'string') {
        try {
            return JSON.parse(output) as Record<string, unknown>
        } catch {
            return null
        }
    }
    if (typeof output === 'object' && !Array.isArray(output)) {
        const anyObj = output as Record<string, unknown>

        // ① LangChain ToolMessage 序列化结构：
        //    { lc:1, type:'constructor', id:['langchain_core','messages','ToolMessage'],
        //      kwargs:{ status, content: '<real JSON string>' } }
        //    八股 04 §6 MCP 协议：MCP 工具返回在 LangChain 层会被包成 ToolMessage
        if (
            anyObj.lc === 1 &&
            anyObj.type === 'constructor' &&
            anyObj.kwargs &&
            typeof anyObj.kwargs === 'object'
        ) {
            const kwargs = anyObj.kwargs as Record<string, unknown>
            return toObject(kwargs.content)
        }

        // ② MCP 标准 content 数组：[{ type:'text', text:'<JSON>' }]
        if (Array.isArray(anyObj.content)) {
            const first = anyObj.content[0] as Record<string, unknown> | undefined
            if (first && typeof first.text === 'string') return toObject(first.text)
        }

        // ③ 兼容包一层 content/text（langgraphToAgUi 已提取过，这里再兜底一次）
        if (anyObj.content && typeof anyObj.content === 'string' && !anyObj.route) {
            const parsed = toObject(anyObj.content)
            if (parsed) return parsed
        }

        return anyObj
    }
    return null
}

/**
 * 防御性解析高德 MCP 路径规划工具的输出
 * 八股 04 §6：MCP 工具返回结构不可控，解析失败返回 null，由 caller 决定是否兜底
 *
 * 高德 MCP 实际返回结构（以 logs/app.log tool finished 为据）:
 *   { origin, destination, paths: [{ path, distance, duration,
 *       steps: [{ instruction, road, distance, path, ... }] }] }
 * 注意：折线坐标字段是 `path`（不是 polyline），值为 "lng,lat;lng,lat;..."
 */
export function parseAmapRoute(mode: MapRouteEvent['mode'], output: unknown): AmapRouteParsed | null {
    try {
        const obj = toObject(output)
        if (!obj) return null

        // 高德 direction API 顶层结构：{ origin, destination, paths:[...] } 或 { route:{...} }
        const route = (obj.route ?? obj) as Record<string, unknown>
        const paths = (route.paths as unknown[] | undefined) ?? (obj.paths as unknown[] | undefined)

        // 调试日志：顶层结构诊断
        // eslint-disable-next-line no-console
        console.error('[parseAmapRoute] obj keys=', Object.keys(obj),
            'paths type=', Array.isArray(paths) ? `array(${paths.length})` : typeof paths,
            'first keys=', Array.isArray(paths) && paths[0] ? Object.keys(paths[0] as object) : 'none')

        let allPoints: Array<[number, number]> = []
        let distanceMeters: number | undefined
        let durationSeconds: number | undefined

        if (Array.isArray(paths) && paths.length > 0) {
            const first = paths[0] as Record<string, unknown> | undefined
            const steps = first?.steps as Array<Record<string, unknown>> | undefined
            // eslint-disable-next-line no-console
            console.error('[parseAmapRoute] first=', first ? Object.keys(first) : 'null',
                'steps type=', Array.isArray(steps) ? `array(${steps.length})` : typeof steps,
                'first step sample=', Array.isArray(steps) && steps[0] ? JSON.stringify(steps[0]).slice(0, 300) : 'none')
            if (Array.isArray(steps)) {
                for (let i = 0; i < steps.length; i++) {
                    const step = steps[i]!
                    // 高德 MCP 折线字段是 `path`（与官方 REST API 的 `polyline` 不同）
                    const polyline = (step?.path ?? step?.polyline) as unknown
                    // eslint-disable-next-line no-console
                    if (i < 3) console.error(`[parseAmapRoute] step[${i}] path type=`, typeof polyline, 'isArr=', Array.isArray(polyline), 'sample=', typeof polyline === 'string' ? polyline.slice(0, 100) : JSON.stringify(polyline).slice(0, 200))
                    if (typeof polyline === 'string' && polyline) allPoints = allPoints.concat(parsePolyline(polyline))
                }
            }
            // path 顶层也可能带折线（备用路径）
            if (allPoints.length < 2) {
                const topPath = first?.path as unknown
                // eslint-disable-next-line no-console
                console.error('[parseAmapRoute] top path type=', typeof topPath, 'sample=', typeof topPath === 'string' ? topPath.slice(0, 100) : JSON.stringify(topPath).slice(0, 200))
                if (typeof topPath === 'string' && topPath) allPoints = allPoints.concat(parsePolyline(topPath))
            }
            const d = Number(first?.distance)
            const t = Number(first?.duration)
            if (Number.isFinite(d) && d > 0) distanceMeters = d
            if (Number.isFinite(t) && t > 0) durationSeconds = t
        }

        allPoints = dedupeAdjacent(allPoints)

        // 解析起终点坐标（无论是否有折线都尝试解析）
        const origin = parseCoord(route.origin) ?? parseCoord(obj.origin) ?? allPoints[0]
        const destination = parseCoord(route.destination) ?? parseCoord(obj.destination) ?? allPoints[allPoints.length - 1]

        // 当 MCP 未返回详细折线（step.path 全为空）时，用起终点构成直线作为兜底
        // 这样前端仍能渲染地图并展示距离/耗时信息，而不是整张地图不出现
        if (allPoints.length < 2) {
            if (origin && destination) {
                allPoints = [origin, destination]
            } else if (origin) {
                allPoints = [origin]
            } else if (destination) {
                allPoints = [destination]
            } else {
                return null
            }
        }

        const originName = (route.originName as string | undefined) ?? (obj.originName as string | undefined)
        const destinationName = (route.destinationName as string | undefined) ?? (obj.destinationName as string | undefined)

        return {
            mode,
            origin,
            destination,
            path: allPoints,
            distanceMeters,
            durationSeconds,
            originName,
            destinationName
        }
    } catch {
        return null
    }
}
