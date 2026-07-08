-- Task 4.3（2026-06-03）：记忆分层 — 会话级用户偏好摘要
-- 关联：src/agent/memory.ts、src/db/chatRepo.ts
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS summary TEXT NULL;