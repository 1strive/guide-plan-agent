import { config } from 'dotenv'
config()
config({ path: '.env.local', override: true })
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { loadDbConfig } from '../src/config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  const config = loadDbConfig()

  // PostgreSQL 不支持 CREATE DATABASE IF NOT EXISTS：
  // 先连默认 postgres 库，查 pg_database 判断目标库是否存在，不存在再建
  const admin = new pg.Client({
    host: config.PG_HOST,
    port: config.PG_PORT,
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    database: 'postgres'
  })
  await admin.connect()
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    config.PG_DATABASE
  ])
  if (exists.rowCount === 0) {
    // 库名不能参数化，只能拼接；用双引号包裹保留大小写并防注入基本形态
    await admin.query(`CREATE DATABASE "${config.PG_DATABASE}"`)
    console.log(`  ✔ database "${config.PG_DATABASE}" created`)
  }
  await admin.end()

  // 连目标库执行迁移。每个 SQL 文件都用 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
  // 保证幂等，不再依赖 MySQL 的 1050/1060 错误码兜底
  const conn = new pg.Client({
    host: config.PG_HOST,
    port: config.PG_PORT,
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    database: config.PG_DATABASE
  })
  await conn.connect()

  const migrationsDir = join(__dirname, '..', 'src', 'db', 'migrations')
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const sqlPath = join(migrationsDir, file)
    const sql = readFileSync(sqlPath, 'utf8')
    await conn.query(sql)
    console.log(`  ✔ ${file}`)
  }

  await conn.end()
  console.log('Migration OK:', config.PG_DATABASE)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
