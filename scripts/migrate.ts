import { config } from 'dotenv'
config()
config({ path: '.env.local', override: true })
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { loadDbConfig } from '../src/config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  const config = loadDbConfig()
  const conn = await mysql.createConnection({
    host: config.MYSQL_HOST,
    port: config.MYSQL_PORT,
    user: config.MYSQL_USER,
    password: config.MYSQL_PASSWORD,
    multipleStatements: true
  })
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  )
  await conn.query(`USE \`${config.MYSQL_DATABASE}\``)
  const sqlPath = join(__dirname, '..', 'src', 'db', 'migrations', '001_init.sql')
  const sql = readFileSync(sqlPath, 'utf8')
  await conn.query(sql)
  await conn.end()
  console.log('Migration OK:', config.MYSQL_DATABASE)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
