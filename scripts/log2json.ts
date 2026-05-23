import fs from 'node:fs'
import path from 'node:path'

const logPath = path.resolve('logs/app.log')
const jsonPath = path.resolve('logs/app.json')

const content = fs.readFileSync(logPath, 'utf-8')
const lines = content.split('\n').filter(l => l.trim())
const entries = lines.map(l => JSON.parse(l))

fs.writeFileSync(jsonPath, JSON.stringify(entries, null, 2), 'utf-8')
console.log(`已转换 ${entries.length} 条日志 → ${jsonPath}`)
