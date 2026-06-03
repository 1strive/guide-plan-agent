/**
 * Task 4.4 — Agent Skill 类型定义
 *
 * 规划:docs/开发规划.md Task 4.4
 * 八股:04-工具调用.md §7 Agent Skills(工具 → 工具集 → 技能三层抽象)
 */

export type Skill = {
  name: string
  description: string
  systemPromptExtension: string
  requiredTools: string[]
  triggerKeywords?: string[]
}
