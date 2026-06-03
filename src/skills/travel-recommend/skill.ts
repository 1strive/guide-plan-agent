/**
 * Task 4.4 — 旅行目的地推荐 Skill
 *
 * 组合地图 POI 搜索 + 网页抓取,帮助用户发现和比较旅行目的地。
 * 触发词:推荐、目的地、去哪、旅行、旅游等。
 */

import type { Skill } from '../types.js'

export const travelRecommendSkill: Skill = {
  name: '旅行目的地推荐',
  description: '使用地图 POI 搜索和网络信息帮助用户发现和比较旅行目的地',
  systemPromptExtension: '推荐目的地时,优先使用地图工具搜索实际 POI 数据,结合网页信息给出可执行建议。如果有天气和路线工具,一并提供出行参考。',
  requiredTools: ['fetch'],
  triggerKeywords: ['推荐', '目的地', '去哪', '旅行', '旅游', '景点']
}
