import { useEffect, useMemo, useRef, useState } from "react";
import AMapLoader from "@amap/amap-jsapi-loader";
import type { MapRouteData } from "../types";

/** 高德 JS API Key / 安全密钥（Vite 编译时注入，空字符串 = 未配置） */
const AMAP_KEY = (import.meta.env.VITE_AMAP_JS_KEY as string | undefined) ?? "";
const AMAP_SECURITY_CODE =
  (import.meta.env.VITE_AMAP_SECURITY_CODE as string | undefined) ?? "";

const MODE_PLUGIN: Record<MapRouteData["mode"], string> = {
  driving: "AMap.Driving",
  walking: "AMap.Walking",
  bicycling: "AMap.Riding",
  transit: "AMap.Transfer",
};
const MODE_LABEL: Record<MapRouteData["mode"], string> = {
  driving: "驾车",
  walking: "步行",
  bicycling: "骑行",
  transit: "公交",
};
const MODE_COLOR: Record<MapRouteData["mode"], string> = {
  driving: "#2563EB",
  walking: "#16a34a",
  bicycling: "#f59e0b",
  transit: "#7c3aed",
};

/**
 * 路线地图组件（含交通工具切换）
 *
 * 实现思路：
 * - 高德 MCP 路径规划工具的 step.path 经常为空（MCP 不下发折线坐标）
 * - 前端用 AMap JS API 自带 Driving/Walking/Transfer/Riding 插件重新规划路径
 * - 同一消息内多种出行方式 → 单张地图 + Tab 切换
 */
export function RouteMapView({ route }: { route: MapRouteData }) {
  const allRoutes = useAllRoutes(route);
  return <MapCard routes={allRoutes} />;
}

function MapCard({ routes }: { routes: MapRouteData[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<
    "loading" | "ready" | "error" | "no-key" | "no-route"
  >("loading");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const [planInfo, setPlanInfo] = useState<{
    distanceMeters?: number;
    durationSeconds?: number;
  }>({});
  const activeRoute = routes[activeIdx] ?? routes[0];

  useEffect(() => {
    if (!AMAP_KEY) {
      setStatus("no-key");
      return;
    }
    if (!containerRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let map: any = null;
    let destroyed = false;
    const container = containerRef.current;
    const w = window as unknown as {
      _AMapSecurityConfig?: { securityJsCode: string };
    };
    if (AMAP_SECURITY_CODE)
      w._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY_CODE };

    const plugins = Array.from(new Set(routes.map((r) => MODE_PLUGIN[r.mode])));

    AMapLoader.load({ key: AMAP_KEY, version: "2.0", plugins })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((AMap: any) => {
        if (destroyed || !container) return;
        map = new AMap.Map(container, { resizeEnable: true, zooms: [3, 18] });

        // 只渲染当前选中的交通方式：切换 Tab 时 activeIdx 变化 → useEffect 重建地图 → 只画新路线
        for (const r of routes) {
          if (r !== activeRoute) continue;
          if (!r.origin || !r.destination) continue;
          const PluginCtor = (AMap as any)[MODE_PLUGIN[r.mode]];
          if (!PluginCtor) {
            console.error(
              `[RouteMapView] plugin ${MODE_PLUGIN[r.mode]} not loaded, fallback`,
            );
            drawFallback(AMap, map, r, r === activeRoute);
            continue;
          }
          const isActive = r === activeRoute;
          try {
            // 公交换乘（Transfer）构造需 city 参数（官方必填），缺失时从后端下发的 route.city 取，
            // 再不行用 '全国' 兑底（部分场景 AMap 会根据坐标自适应）
            const plannerOpts: Record<string, unknown> = {
              map,
              autoFitView: false,
            };
            if (r.mode === "transit") {
              plannerOpts.city = r.city ?? "全国";
            }
            const planner = new PluginCtor(plannerOpts);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            planner.plan(r.origin, r.destination, (s: string, data: any) => {
              console.log(
                `[RouteMapView] ${r.mode} plan status=`,
                s,
                "routes=",
                data?.routes?.length ?? data?.plans?.length,
              );
              if (destroyed) return;
              if (s === "complete") {
                if (r.mode === "transit") {
                  // 公交结果结构为 plans/segments
                  drawTransitPlan(AMap, map, data, isActive);
                  if (isActive) {
                    const p0 = data?.plans?.[0] as any;
                    setPlanInfo({
                      distanceMeters: Number(p0?.distance) || undefined,
                      durationSeconds: Number(p0?.time) || undefined,
                    });
                  }
                } else if (data?.routes) {
                  drawPlan(AMap, map, data.routes, r.mode, isActive);
                  if (isActive) {
                    const first = data.routes[0] as any;
                    setPlanInfo({
                      distanceMeters: Number(first?.distance) || undefined,
                      durationSeconds:
                        Number(first?.time ?? first?.duration) || undefined,
                    });
                  }
                }
              } else if (s === "no_data" || s === "error") {
                console.warn(`[RouteMapView] ${r.mode} plan ${s}:`, data);
                drawFallback(AMap, map, r, isActive);
              }
            });
          } catch (e) {
            console.error(`[RouteMapView] ${r.mode} plan threw:`, e);
            drawFallback(AMap, map, r, isActive);
          }
        }

        // 兜底：若异步回调未触发，0.5s 后检查覆盖物，仍无则画 fallback（仅当前选中路线）
        setTimeout(() => {
          if (destroyed || !map) return;
          const overlays = map.getAllOverlays?.() ?? [];
          if (Array.isArray(overlays) && overlays.length === 0 && activeRoute) {
            drawFallback(AMap, map, activeRoute, true);
          }
        }, 500);

        if (activeRoute?.origin) {
          map.add(
            new AMap.Marker({
              position: activeRoute.origin,
              content: `<div style="background:#16a34a;color:#fff;padding:2px 8px;border-radius:999px;font-size:12px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.2)">起${activeRoute.originName ? " " + escapeHtml(activeRoute.originName) : ""}</div>`,
              offset: new AMap.Pixel(-10, -10),
            }),
          );
        }
        if (activeRoute?.destination) {
          map.add(
            new AMap.Marker({
              position: activeRoute.destination,
              content: `<div style="background:#dc2626;color:#fff;padding:2px 8px;border-radius:999px;font-size:12px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.2)">终${activeRoute.destinationName ? " " + escapeHtml(activeRoute.destinationName) : ""}</div>`,
              offset: new AMap.Pixel(-10, -10),
            }),
          );
        }
        map.setFitView(null, false, [40, 40, 40, 40]);
        setStatus(routes.length > 0 ? "ready" : "no-route");
      })
      .catch((e: unknown) => {
        setErrorMsg(`渲染地图失败：${(e as Error).message}`);
        setStatus("error");
      });

    return () => {
      destroyed = true;
      try {
        if (map && typeof map.destroy === "function") map.destroy();
      } catch {
        /* ignore */
      }
      map = null;
    };
  }, [routes, activeIdx]);

  useEffect(() => setPlanInfo({}), [activeIdx]);

  const displayDistance =
    planInfo.distanceMeters ?? activeRoute?.distanceMeters;
  const displayDuration =
    planInfo.durationSeconds ?? activeRoute?.durationSeconds;

  return (
    <div className="mt-3 rounded-xl overflow-hidden border border-gray-200 shadow-sm bg-white">
      {routes.length > 1 && (
        <div className="flex items-center gap-1 px-2 pt-2 bg-white">
          {routes.map((r, i) => (
            <button
              key={i}
              onClick={() => setActiveIdx(i)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${i === activeIdx ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
              style={
                i === activeIdx
                  ? { backgroundColor: MODE_COLOR[r.mode] }
                  : undefined
              }
            >
              {MODE_LABEL[r.mode]}
            </button>
          ))}
        </div>
      )}
      <div
        ref={containerRef}
        className="h-72 w-full bg-gray-100 relative"
        aria-label="导航路线地图"
      >
        {status === "no-key" && (
          <div className="absolute inset-0 grid place-items-center text-sm text-gray-500">
            <div className="text-center px-6">
              <div className="mb-1 font-medium">未配置高德 JS API Key</div>
              <div className="text-xs text-gray-400">
                请在 <code>web/.env</code> 设置 <code>VITE_AMAP_JS_KEY</code>
              </div>
            </div>
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 grid place-items-center text-sm text-red-600 px-6 text-center">
            {errorMsg}
          </div>
        )}
        {status === "loading" && (
          <div className="absolute inset-0 grid place-items-center text-sm text-gray-500">
            地图加载中…
          </div>
        )}
        {status === "no-route" && (
          <div className="absolute inset-0 grid place-items-center text-sm text-gray-500">
            无可渲染的路线数据
          </div>
        )}
      </div>
      <div className="px-4 py-2 flex items-center gap-4 text-sm border-t border-gray-100">
        <span
          className="px-2 py-0.5 rounded text-white text-xs font-medium"
          style={{
            backgroundColor: MODE_COLOR[activeRoute?.mode ?? "driving"],
          }}
        >
          {MODE_LABEL[activeRoute?.mode ?? "driving"]}
        </span>
        {displayDistance != null && displayDistance > 0 && (
          <span className="text-gray-700">
            {formatDistance(displayDistance)}
          </span>
        )}
        {displayDuration != null && displayDuration > 0 && (
          <span className="text-gray-500">
            {formatDuration(displayDuration)}
          </span>
        )}
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawPlan(
  AMap: any,
  map: any,
  routes: any[],
  mode: MapRouteData["mode"],
  isActive: boolean,
) {
  if (!Array.isArray(routes) || routes.length === 0) return;
  const first = routes[0] as any;
  const steps = first?.steps as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(steps)) return;
  const path: Array<[number, number]> = [];
  for (const step of steps) {
    // AMap JS API 2.0 的 step.path 是 Array<LngLat>（LngLat 对象，非 [lng,lat] 数组）
    collectLngLat(step?.path, path);
  }
  if (path.length >= 2) {
    map.add(
      new AMap.Polyline({
        path,
        strokeColor: MODE_COLOR[mode],
        strokeWeight: 6,
        strokeOpacity: isActive ? 0.95 : 0.5,
        lineJoin: "round",
        lineCap: "round",
      }),
    );
  }
}

/**
 * 公交换乘（Transfer）结果结构与驾车/步行不同：
 *   result.plans[0].segments[] → 每段含 walking.path / transit.path 等
 * 遍历所有 segment 收集 LngLat 折线。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawTransitPlan(AMap: any, map: any, data: any, isActive: boolean) {
  const plans = data?.plans as any[] | undefined;
  if (!Array.isArray(plans) || plans.length === 0) return false;
  const segments = plans[0]?.segments as any[] | undefined;
  if (!Array.isArray(segments)) return false;

  const path: Array<[number, number]> = [];
  for (const seg of segments) {
    // 步行段
    if (seg?.walking?.path) collectLngLat(seg.walking.path, path);
    if (Array.isArray(seg?.walking?.steps)) {
      for (const st of seg.walking.steps) collectLngLat(st?.path, path);
    }
    // 公交/地铁段：via_stops 或 path
    if (seg?.transit?.path) collectLngLat(seg.transit.path, path);
    if (Array.isArray(seg?.transit?.via_stops)) {
      for (const stop of seg.transit.via_stops)
        collectLngLat(stop?.location, path);
    }
  }
  if (path.length >= 2) {
    map.add(
      new AMap.Polyline({
        path,
        strokeColor: MODE_COLOR.transit,
        strokeWeight: 6,
        strokeOpacity: isActive ? 0.95 : 0.5,
        lineJoin: "round",
        lineCap: "round",
      }),
    );
    return true;
  }
  return false;
}

/**
 * 把 AMap 返回的坐标容器统一提取为 [lng,lat] 追加到 out。
 * 兼容三种形态：
 *   1. Array<LngLat>（对象含 lng/lat 或 getLng/getLat）
 *   2. Array<[lng,lat]>（数组）
 *   3. 单个 LngLat 对象
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectLngLat(container: any, out: Array<[number, number]>) {
  if (!container) return;
  if (Array.isArray(container)) {
    for (const pt of container) {
      const ll = toLngLatPair(pt);
      if (ll) out.push(ll);
    }
  } else {
    const ll = toLngLatPair(container);
    if (ll) out.push(ll);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toLngLatPair(pt: any): [number, number] | null {
  if (!pt) return null;
  // LngLat 对象：优先 getLng/getLat 方法
  if (typeof pt.getLng === "function" && typeof pt.getLat === "function") {
    const lng = pt.getLng();
    const lat = pt.getLat();
    if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
  }
  // 属性 lng/lat（或 R/Q/大小写变体由 SDK 决定，这里取标准 lng/lat）
  if (typeof pt.lng === "number" && typeof pt.lat === "number") {
    return [pt.lng, pt.lat];
  }
  // [lng, lat] 数组
  if (Array.isArray(pt) && pt.length === 2) {
    const lng = Number(pt[0]);
    const lat = Number(pt[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawFallback(AMap: any, map: any, r: MapRouteData, isActive: boolean) {
  if (!Array.isArray(r.path) || r.path.length < 2) return;
  map.add(
    new AMap.Polyline({
      path: r.path.map((p) => p),
      strokeColor: MODE_COLOR[r.mode],
      strokeWeight: 6,
      strokeOpacity: isActive ? 0.95 : 0.5,
      strokeStyle: "dashed",
      lineJoin: "round",
      lineCap: "round",
    }),
  );
}

function useAllRoutes(current: MapRouteData): MapRouteData[] {
  return useMemo(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useChatStore } = require("../store/chatStore") as {
        useChatStore: () => {
          messages: Array<{ role?: string; mapRoutes?: MapRouteData[] }>;
        };
      };
      const store = useChatStore();
      const last = [...store.messages]
        .reverse()
        .find(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.mapRoutes) &&
            m.mapRoutes!.length > 0,
        );
      if (last?.mapRoutes && last.mapRoutes.length > 0) return last.mapRoutes;
    } catch {
      /* 降级 */
    }
    return [current];
  }, [current]);
}

function formatDistance(meters?: number): string {
  if (!meters || meters <= 0) return "";
  if (meters < 1000) return `${Math.round(meters)} 米`;
  return `${(meters / 1000).toFixed(1)} 公里`;
}
function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "";
  const min = Math.round(seconds / 60);
  if (min < 60) return `约 ${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `约 ${h} 小时 ${m} 分钟`;
}
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
