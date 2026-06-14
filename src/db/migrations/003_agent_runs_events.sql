-- Task 整合-2(2026-05-31):Run-as-Resource 完整版
-- 新增 agent_runs(完整状态机)
-- 同时给 chat_sessions 加 status 字段(供 /messages 快查)
--
-- 注:原 agent_run_events 表已移除(事件流由 Redis Stream + archived_run_events 替代,见 006 migration)
--
-- 关联:
--   docs/开发规划.md 整合阶段 Task 整合-2
--   docs/04-架构文档/agent-架构.md §3.6+ / §4.4(整合-2 落地后更新)
--   src/agent/runManager.ts(读写 agent_runs + chat_sessions.status)

CREATE TABLE IF NOT EXISTS agent_runs (
    run_id CHAR(36) NOT NULL PRIMARY KEY,
    session_id CHAR(36) NOT NULL,
    -- 完整状态机:
    --   pending   → 创建但 LangGraph 尚未真正开跑(短暂中间态)
    --   running   → 在跑
    --   completed → LangGraph 正常 finish
    --   interrupted → 命中 [ASK_USER] 反问
    --   cancelling → 收到 cancel 请求,正在停
    --   cancelled  → 已停
    --   failed    → 异常 / 进程重启清理
    status ENUM(
        'pending',
        'running',
        'completed',
        'interrupted',
        'cancelling',
        'cancelled',
        'failed'
    ) NOT NULL DEFAULT 'pending',
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP NULL,
    -- 最大 seq,供 /runs/active 给前端续订时知道从哪续
    last_event_seq INT UNSIGNED NOT NULL DEFAULT 0,
    total_tokens INT UNSIGNED NOT NULL DEFAULT 0,
    CONSTRAINT fk_agent_runs_session FOREIGN KEY (session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE,
    -- /runs/active 高频查"该 session 最近未完成 Run"
    KEY idx_agent_runs_session_status_started (
        session_id,
        status,
        started_at
    )
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- chat_sessions 加 status 字段(简化 'running'|'end',供 GET /messages 快查前端用)
-- 注:跟 agent_runs.status 不同步是 OK 的,前者是"该 session 是否有活跃 Run"的快照
ALTER TABLE chat_sessions
ADD COLUMN status ENUM('running', 'end') NOT NULL DEFAULT 'end' AFTER total_tokens;