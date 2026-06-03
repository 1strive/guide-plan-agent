/**
 * Task 4.4 — Skill 注册表 + prompt 段落构建
 *
 * 规划:docs/开发规划.md Task 4.4
 * 八股:04-工具调用.md §7 Agent Skills
 *
 * getAllSkills() 返回所有注册的 Skill;
 * buildSkillsPromptSection() 根据实际可用工具过滤,生成注入 system prompt 的段落。
 */

import type { Skill } from './types.js'
import { travelRecommendSkill } from './travel-recommend/skill.js'
import { localResearchSkill } from './local-research/skill.js'

const registry: Skill[] = [
  travelRecommendSkill,
  localResearchSkill
]

export function getAllSkills(): Skill[] {
  return registry
}

export function buildSkillsPromptSection(
  skills: Skill[],
  availableToolNames: string[]
): string {
  const activeSkills = skills.filter(s =>
    s.requiredTools.length === 0 ||
    s.requiredTools.some(t => availableToolNames.includes(t))
  )

  if (activeSkills.length === 0) return ''

  const lines = ['你具备以下专项能力:']
  for (const s of activeSkills) {
    lines.push(`- **${s.name}**: ${s.description}`)
    if (s.systemPromptExtension) {
      lines.push(`  ${s.systemPromptExtension}`)
    }
  }
  return lines.join('\n')
}
