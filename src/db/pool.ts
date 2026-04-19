import mysql from 'mysql2/promise'
import type { AppConfig, DbConfig } from '../config.js'

export function createPool(config: AppConfig | DbConfig) {
  return mysql.createPool({
    host: config.MYSQL_HOST,
    port: config.MYSQL_PORT,
    user: config.MYSQL_USER,
    password: config.MYSQL_PASSWORD,
    database: config.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10
  })
}

export type DbPool = ReturnType<typeof createPool>
