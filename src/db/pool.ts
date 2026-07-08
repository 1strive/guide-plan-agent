import pg from 'pg'
import type { AppConfig, DbConfig } from '../config.js'

// PostgreSQL 连接池（node-postgres）
// - createPool 返回 pg.Pool，query 返回 { rows, rowCount }
// - LangGraph PostgresSaver 也复用同一个 Pool（见 src/agent/langgraph-agent.ts）
export function createPool(config: AppConfig | DbConfig): pg.Pool {
  return new pg.Pool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    database: config.PG_DATABASE,
    max: 10
  })
}

export type DbPool = pg.Pool
