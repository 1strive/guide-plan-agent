-- Task 3.7(2026-06-01):Tavily 联网搜索结果缓存表
-- 同 query+depth 复用,避免烧 Tavily 免费额度(1000 次/月)
-- TTL 由调用方逻辑控制(config.WEB_SEARCH_CACHE_TTL_SECONDS,默认 24h)
--
-- 关联:src/agent/webSearchCache.ts,src/agent/tools.ts:web_search

CREATE TABLE IF NOT EXISTS web_search_cache (
  -- SHA-256(query + depth) hex,固定 64 字符
  cache_key CHAR(64) NOT NULL PRIMARY KEY,
  -- Tavily 原始响应 JSON;TTL 检查靠 created_at 比对
  response_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_web_search_cache_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
