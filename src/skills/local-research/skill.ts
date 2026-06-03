/**
 * Task 4.4 — 信息调研 Skill
 *
 * 组合网页抓取 + 文件系统,获取目的地的最新攻略、价格和实时信息。
 * 触发词:价格、攻略、最新、开放时间、门票等。
 */

import type { Skill } from '../types.js'

export const localResearchSkill: Skill = {
  name: '信息调研',
  description: '使用网页抓取获取目的地的最新攻略、价格和实时信息',
  systemPromptExtension: '当用户需要最新信息(如门票价格、开放时间、交通方式)时,使用 fetch 工具从权威网站获取数据,不要凭训练记忆编造时效性信息。',
  requiredTools: ['fetch'],
  triggerKeywords: ['价格', '攻略', '最新', '开放时间', '门票', '天气']
}
