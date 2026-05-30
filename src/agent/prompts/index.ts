/**
 * Task 2.1 — Prompt 版本注册表与入口
 *
 * 规划:docs/开发规划.md Task 2.1(多版本存储 + 版本切换机制)
 * 八股:09-Prompt工程.md §2.4 迭代优化(版本化是 A/B 评测的前提)
 *
 * 使用方式:
 *   const { system, prependMessages } = getPrompt(config.PROMPT_VERSION)
 *   msgs.push({ role: 'system', content: system })
 *   msgs.push(...prependMessages)  // Few-shot 示例(若有)
 *
 * 新增版本步骤:
 *   1. 新建 src/agent/prompts/vN_xxx.ts 导出 PromptTemplate
 *   2. 在本文件 registry 中注册
 *   3. .env 或 PROMPT_VERSION 环境变量切换;评测脚本可直接传 version 参数
 */

import { renderPrompt } from './render.js'
import type { PromptTemplate, RenderedPrompt } from './types.js'
import { v1Base } from './v1_base.js'
import { v2Cot } from './v2_cot.js'

const registry: Record<string, PromptTemplate> = {
  v1_base: v1Base,
  v2_cot: v2Cot
}

export function listPromptVersions(): string[] {
  return Object.keys(registry)
}

export function getPrompt(
  version: string,
  vars: Record<string, string> = {}
): RenderedPrompt {
  const template = registry[version]
  if (!template) {
    throw new Error(
      `unknown prompt version: ${version}, available: ${listPromptVersions().join(', ')}`
    )
  }
  return renderPrompt(template, vars)
}

export type { PromptTemplate, RenderedPrompt, FewShotExample } from './types.js'
