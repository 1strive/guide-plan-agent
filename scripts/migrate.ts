import { config } from 'dotenv'
config()
config({ path: '.env.local', override: true })
import { readFileSync, readdirSync } from 'node:fs'
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

  const migrationsDir = join(__dirname, '..', 'src', 'db', 'migrations')
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const sqlPath = join(migrationsDir, file)
    const sql = readFileSync(sqlPath, 'utf8')
    try {
      await conn.query(sql)
      console.log(`  ✔ ${file}`)
    } catch (err: any) {
      // 忽略"列已存在"或"表已存在"等幂等错误
      if (err.errno === 1060 || err.errno === 1050) {
        console.log(`  ⊘ ${file} (already applied)`)
      } else {
        throw err
      }
    }
  }

  await conn.end()
  console.log('Migration OK:', config.MYSQL_DATABASE)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
