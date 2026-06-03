/**
 * Task 2.1 — Prompt 模板渲染器
 *
 * 规划:docs/开发规划.md Task 2.1(模板引擎 + 变量插值)
 * 八股:09-Prompt工程.md §1.3 基本结构 / §2.3 结构化设计 / §3.5 Few-shot 注入形式
 *
 * 实现要点:
 * - section 顺序固定:role → taskScope → 工具规则 → 输出格式 → 上下文规则 → 反问规则 → CoT
 *   (对齐八股 09 §1.3 推荐的"角色—任务—约束—输出"结构)
 * - 变量插值:简单 {{name}} 替换,不引入 handlebars 等模板引擎(KISS)
 * - examples 不拼进 system,而是返回独立 prependMessages 数组——
 *   八股 09 §3.5 明确推荐 Few-shot 用真实对话形式,模型理解更稳、token 也省
 */

import type { PromptTemplate, RenderedPrompt } from './types.js'

function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? '')
}

function renderRuleList(title: string, rules: string[]): string {
  return `${title}\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
}

export function renderPrompt(
  template: PromptTemplate,
  vars: Record<string, string> = {}
): RenderedPrompt {
  const sections: string[] = []

  sections.push(interpolate(template.role, vars))

  if (template.taskScope) {
    sections.push(interpolate(template.taskScope, vars))
  }
  // Task 4.3:记忆上下文(interpolate 后为空则跳过,不污染无记忆的 prompt)
  if (template.memoryContext) {
    const rendered = interpolate(template.memoryContext, vars).trim()
    if (rendered) sections.push(rendered)
  }
  // Task 4.4:技能上下文
  if (template.skillsContext) {
    const rendered = interpolate(template.skillsContext, vars).trim()
    if (rendered) sections.push(rendered)
  }
  if (template.toolUsageRules && template.toolUsageRules.length > 0) {
    sections.push(
      renderRuleList(
        '工具调用规则:',
        template.toolUsageRules.map((r) => interpolate(r, vars))
      )
    )
  }
  if (template.outputFormat && template.outputFormat.length > 0) {
    sections.push(
      renderRuleList(
        '输出格式约束:',
        template.outputFormat.map((r) => interpolate(r, vars))
      )
    )
  }
  if (template.contextRules && template.contextRules.length > 0) {
    sections.push(
      renderRuleList(
        '上下文使用规则:',
        template.contextRules.map((r) => interpolate(r, vars))
      )
    )
  }
  if (template.clarificationRules && template.clarificationRules.length > 0) {
    sections.push(
      renderRuleList(
        '反问规则:',
        template.clarificationRules.map((r) => interpolate(r, vars))
      )
    )
  }
  if (template.securityRules && template.securityRules.length > 0) {
    // 八股 09 §8:防 Prompt 注入指令,放在 clarification 之后、CoT 之前;
    // 模型读到这里时已经知道角色/规则/反问协议,接下来才被告知"你必须区分指令和数据"
    sections.push(
      renderRuleList(
        '安全防御规则:',
        template.securityRules.map((r) => interpolate(r, vars))
      )
    )
  }
  if (template.cotInstruction) {
    // Task 2.2 / 八股 09 §4.2:Zero-shot CoT 触发指令,放在 system 末尾
    sections.push(interpolate(template.cotInstruction, vars))
  }

  const system = sections.join('\n\n')

  // 八股 09 §3.5:Few-shot 以 user/assistant 对话形式注入,模型理解更稳
  const prependMessages = (template.examples ?? []).flatMap((ex) => [
    { role: 'user' as const, content: ex.user },
    { role: 'assistant' as const, content: ex.assistant }
  ])

  return { system, prependMessages }
}
