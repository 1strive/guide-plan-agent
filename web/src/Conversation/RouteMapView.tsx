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

/** 前端展示的交通方式顺序（仅用于多条路线同时下发时的 Tab 排序） */
const MODE_ORDER: MapRouteData["mode"][] = [
  "driving",
  "transit",
  "walking",
  "bicycling",
];

/**
 * 路线地图组件
 *
 * 实现思路（高德官方 JS API 2.0 名称形式检索）：
 * - 后端 plan_route 工具下发确定的单一 mode + 有序 points（地点名称）
 * - 前端构造 Driving/Walking/Riding/Transfer 时传入 map，用名称形式
 *   search([{keyword,city}...]) → 高德内部地理编码并自动绘制导航线 + 起终点 marker
 * - 首=起点、末=终点、中间=途经点（支持多目的地/环线）；环线由后端在末尾补回起点
 * - 公交（Transfer）名称形式仅取首/末两点，途经点忽略（AMap 限制）
 *
 * 按需求：只渲染意图确定的单一出行方式，不再强制展开全部 4 个 Tab。
 * 若同一消息意外下发多条 MAP_ROUTE，保留多 Tab 切换能力。
 */
export function RouteMapView({ routes }: { routes: MapRouteData[] }) {
  if (!routes || routes.length === 0) return null;
  // 只保留可渲染的路线（名称形式 points 或坐标形式 path 至少一种）
  const renderable = routes.filter(
    (r) =>
      (Array.isArray(r.points) && r.points.length >= 2) ||
      (Array.isArray(r.path) && r.path.length >= 2),
  );
  if (renderable.length === 0) return null;
  // 多条路线时按固定出行方式顺序排列 Tab（通常只有一条）
  const ordered = [...renderable].sort(
    (a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode),
  );
  return <MapCard routes={ordered} />;
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
  // 用内容 key 稳定 useEffect 依赖：routes 每次流式投射都是新数组引用，
  // 若直接依赖 routes 会导致流式过程中地图反复销毁重建（偶现不渲染）
  const routesKey = useMemo(
    () =>
      routes
        .map((r) => {
          const pts = r.points?.map((p) => p.name).join(">") ?? "";
          const coords = `${r.origin?.join(",")}>${r.destination?.join(",")}`;
          return `${r.mode}:${pts}|${coords}`;
        })
        .join("|"),
    [routes],
  );

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

    if (!activeRoute) {
      setStatus("no-route");
      return;
    }

    const plugin = MODE_PLUGIN[activeRoute.mode];
    // 一次性加载所有出行方式的插件：AMapLoader 首次 load 后会缓存 AMap，
    // 后续用不同 plugins 再 load 不会补加载缺失插件，导致切换 Tab 时目标插件 undefined → 退化直线
    const plugins = Array.from(
      new Set(routes.map((rt) => MODE_PLUGIN[rt.mode])),
    );

    AMapLoader.load({ key: AMAP_KEY, version: "2.0", plugins })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((AMap: any) => {
        if (destroyed || !container) return;
        map = new AMap.Map(container, { resizeEnable: true, zooms: [3, 18] });

        const r = activeRoute;
        const usePoints = Array.isArray(r.points) && r.points.length >= 2;
        const useCoords = !!(r.origin && r.destination);
        if (!usePoints && !useCoords) {
          setStatus("no-route");
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // 注意：加载插件用带前缀名 "AMap.Transfer"，但从 AMap 上取构造函数要去掉前缀 → AMap.Transfer
        const ctorName = plugin.replace(/^AMap\./, "");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const PluginCtor = (AMap as any)[ctorName];
        if (!PluginCtor) {
          console.error(`[RouteMapView] plugin ${plugin} not loaded, fallback`);
          drawFallback(AMap, map, r);
          finishView(AMap, map, r);
          setStatus("ready");
          return;
        }

        // 构造：传入 map → search 完成后自动绘制曲线导航线 + 起终点 marker（官方标准）
        // 公交换乘（Transfer）额外需要 city（官方必填），缺失用后端下发的 route.city，再兜底 '全国'
        const plannerOpts: Record<string, unknown> = { map };
        if (r.mode === "driving") plannerOpts.policy = 0; // 0 = 速度优先
        if (r.mode === "transit") plannerOpts.city = r.city ?? "全国";
        const planner = new PluginCtor(plannerOpts);

        // 官方方法名是 search（不是 plan）；兼容极少数只有 plan 的旧构建
        const doSearch: (...args: unknown[]) => void =
          typeof planner.search === "function"
            ? planner.search.bind(planner)
            : planner.plan.bind(planner);

        const onResult = (s: string, data: unknown) => {
          if (destroyed) return;
          // ── 关键调试：打印插件返回的完整数据结构 ──
          console.log(
            `[RouteMapView] mode=${r.mode} status=${s} result =`,
            data,
          );
          if (s === "complete") {
            // 插件已自动把路线画到地图上，这里仅提取距离/耗时
            const d = data as {
              routes?: Array<{ distance?: number; time?: number }>;
              plans?: Array<{ distance?: number; time?: number }>;
            };
            const item = d.routes?.[0] ?? d.plans?.[0];
            setPlanInfo({
              distanceMeters: Number(item?.distance) || undefined,
              durationSeconds: Number(item?.time) || undefined,
            });
          } else {
            console.warn(`[RouteMapView] ${r.mode} search ${s}, use fallback`);
            drawFallback(AMap, map, r);
          }
          if (!destroyed) finishView(AMap, map, r);
        };

        if (usePoints) {
          // 名称形式检索：[{keyword, city}...]；首=起点、末=终点、中间=途经点
          // 高德内部地理编码后自动绘线，支持多目的地/环线（环线由后端在末尾补回起点）
          const kw = r.points!.map((p) => ({
            keyword: p.name,
            city: p.city ?? r.city,
          }));
          // 公交（Transfer）名称形式仅支持首/末两点，途经点忽略（AMap 限制）
          const args = r.mode === "transit" ? [kw[0], kw[kw.length - 1]] : kw;
          doSearch(args, onResult);
        } else {
          // 坐标形式兜底：直接用起终点经纬度
          doSearch(r.origin, r.destination, onResult);
        }

        // 起终点标注 + 视野自适应（名称形式下插件已自绘 marker，此处坐标缺失则仅 fitView）
        finishView(AMap, map, r);
        setStatus("ready");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routesKey, activeIdx]);

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

/** 起终点标注 + 视野自适应 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function finishView(AMap: any, map: any, r: MapRouteData) {
  if (!map) return;
  if (r.origin) {
    map.add(
      new AMap.Marker({
        position: r.origin,
        content: `<div style="background:#16a34a;color:#fff;padding:2px 8px;border-radius:999px;font-size:12px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.2)">起${r.originName ? " " + escapeHtml(r.originName) : ""}</div>`,
        offset: new AMap.Pixel(-10, -10),
      }),
    );
  }
  if (r.destination) {
    map.add(
      new AMap.Marker({
        position: r.destination,
        content: `<div style="background:#dc2626;color:#fff;padding:2px 8px;border-radius:999px;font-size:12px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.2)">终${r.destinationName ? " " + escapeHtml(r.destinationName) : ""}</div>`,
        offset: new AMap.Pixel(-10, -10),
      }),
    );
  }
  try {
    map.setFitView(null, false, [40, 40, 40, 40]);
  } catch {
    /* ignore */
  }
}

/** 兜底：插件规划失败时，用后端下发的起终点画一条直线（虚线，提示非真实路径） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawFallback(AMap: any, map: any, r: MapRouteData) {
  if (!Array.isArray(r.path) || r.path.length < 2) return;
  map.add(
    new AMap.Polyline({
      path: r.path.map((p) => p),
      strokeColor: MODE_COLOR[r.mode],
      strokeWeight: 6,
      strokeOpacity: 0.9,
      strokeStyle: "dashed",
      lineJoin: "round",
      lineCap: "round",
    }),
  );
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
