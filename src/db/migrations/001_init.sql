-- PostgreSQL 旅游规划 Agent 首期 schema

CREATE TABLE IF NOT EXISTS chat_sessions (
    id CHAR(36) NOT NULL PRIMARY KEY,
    title VARCHAR(256) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id CHAR(36) NOT NULL,
    role VARCHAR(10) NOT NULL CHECK (
        role IN ('user', 'assistant', 'system')
    ),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_messages_session FOREIGN KEY (session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created ON chat_messages (session_id, created_at);