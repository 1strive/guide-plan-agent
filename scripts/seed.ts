import mysql from 'mysql2/promise'
import { loadDbConfig } from '../src/config.js'

async function main() {
  const config = loadDbConfig()
  const pool = await mysql.createPool({
    host: config.MYSQL_HOST,
    port: config.MYSQL_PORT,
    user: config.MYSQL_USER,
    password: config.MYSQL_PASSWORD,
    database: config.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 2
  })

  await pool.query('DELETE FROM rag_chunks')
  await pool.query('DELETE FROM destination_features')
  await pool.query('DELETE FROM destinations')

  const destRows = [
    {
      name: '成都',
      region: '四川',
      summary: '休闲美食之都，适合慢节奏城市漫步与亲子轻松行程。',
      tags: JSON.stringify(['美食', '亲子', '轻松', '城市'])
    },
    {
      name: '丽江',
      region: '云南',
      summary: '古城与雪山风光结合，适合想放松又想看自然景观的旅客。',
      tags: JSON.stringify(['雪山', '古城', '放松', '摄影'])
    },
    {
      name: '哈尔滨',
      region: '黑龙江',
      summary: '冰雪城市体验，冬季冰雪项目丰富，夏季也相对凉爽。',
      tags: JSON.stringify(['冰雪', '冬季', '避暑', '异域风情'])
    }
  ]

  for (const d of destRows) {
    await pool.query(
      'INSERT INTO destinations (name, region, summary, tags) VALUES (?, ?, ?, CAST(? AS JSON))',
      [d.name, d.region, d.summary, d.tags]
    )
  }

  type Cat = 'food' | 'scenery' | 'culture'
  const features: Array<{ name: string; region: string; category: Cat; title: string; description: string }> = [
    { name: '成都', region: '四川', category: 'food', title: '火锅', description: '麻辣火锅与串串香是代表性体验，可选择微辣亲子友好锅底。' },
    { name: '成都', region: '四川', category: 'food', title: '小吃', description: '担担面、钟水饺、抄手等小吃适合边走边吃。' },
    { name: '成都', region: '四川', category: 'scenery', title: '宽窄巷子', description: '步行街区，适合轻松散步与拍照。' },
    { name: '成都', region: '四川', category: 'scenery', title: '大熊猫基地', description: '亲子热门景点，建议提前预约并避开正午高温。' },
    { name: '成都', region: '四川', category: 'culture', title: '川剧变脸', description: '可在正规剧场观看，注意演出时间与儿童音量。' },
    { name: '丽江', region: '云南', category: 'food', title: '腊排骨火锅', description: '本地特色锅物，口味相对温和可调整。' },
    { name: '丽江', region: '云南', category: 'food', title: '鸡豆凉粉', description: '古城常见小吃，适合轻食搭配。' },
    { name: '丽江', region: '云南', category: 'scenery', title: '玉龙雪山', description: '雪山景观突出，注意高反与索道预约。' },
    { name: '丽江', region: '云南', category: 'scenery', title: '丽江古城', description: '石板路与水系街巷，适合慢行与夜景。' },
    { name: '丽江', region: '云南', category: 'culture', title: '纳西古乐', description: '民族文化演出，适合对民俗感兴趣的游客。' },
    { name: '哈尔滨', region: '黑龙江', category: 'food', title: '锅包肉', description: '东北菜代表之一，酸甜口受欢迎。' },
    { name: '哈尔滨', region: '黑龙江', category: 'food', title: '红肠', description: '俄式风味肉制品，适合当作伴手礼。' },
    { name: '哈尔滨', region: '黑龙江', category: 'scenery', title: '中央大街', description: '欧式风情步行街，冬季冰雕季氛围强。' },
    { name: '哈尔滨', region: '黑龙江', category: 'scenery', title: '冰雪大世界', description: '大型冰雕雪塑园区（季节性开放）。' },
    { name: '哈尔滨', region: '黑龙江', category: 'culture', title: '冰城冬季节庆', description: '冰雪文化与寒地生活方式体验。' }
  ]

  for (const f of features) {
    await pool.query(
      `
      INSERT INTO destination_features (destination_id, category, title, description)
      SELECT d.id, ?, ?, ?
      FROM destinations d
      WHERE d.name = ? AND d.region = ?
      LIMIT 1
      `,
      [f.category, f.title, f.description, f.name, f.region]
    )
  }

  await pool.end()
  console.log('Seed OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
