-- Task 5.4(2026-06-10):Redis 热层改造 — 新增冷库表 archived_run_events
--
-- 背景:
--   原 agent_run_events 表承担"流式期高频 append"和"历史回放"双职责;
--   流式期写入(几百次/Run)对 MySQL 不友好,且未来多副本部署需要跨进程广播。
--   方案 B 渐进版:高频写入迁到 Redis Stream,Run 终态时整段归档到本表。
--
-- 关联:
--   docs/开发规划.md Task 5.4(Redis Pub/Sub 跨进程预留)
--   docs/01-面试八股文/08-工程化实践.md §4 缓存与热层
--   src/redis/runEventStore.ts(归档写入方)
--   src/db/runRepo.ts queryArchivedEventsAfter / bulkInsertArchivedEvents
--   src/agent/runManager.ts subscribe 双源读取(先 Redis,后此表)
--
-- 设计要点:
-- - 表结构与原 agent_run_events 完全一致(seq + event_json),续订游标语义零变更
-- - 主键 (run_id, seq):INSERT IGNORE 重复归档幂等;续订查询走 PK 顺序扫
-- - FK CASCADE:删 session → 删 agent_runs → 删 archived_run_events,链路完整
-- - 旧 agent_run_events 表保留(停止写入),旧数据保留以便回溯,后续 Task 决定是否清理

CREATE TABLE IF NOT EXISTS archived_run_events (
  run_id CHAR(36) NOT NULL,
  -- 沿用 RunHandle.seqCounter 应用层自增;Redis Stream ID 也用 {seq}-0 显式形式写入
  seq INT UNSIGNED NOT NULL,
  -- 事件全量 JSON(AG-UI 协议序列化结果),回放时直接 emit
  event_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, seq),
  CONSTRAINT fk_archived_run_events_run FOREIGN KEY (run_id)
    REFERENCES agent_runs (run_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
