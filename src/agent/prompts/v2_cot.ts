/**
 * Task 2.2 — v2_cot:在 v1_base 基础上追加 Zero-shot CoT 触发指令
 *
 * 规划:docs/开发规划.md Task 2.2(标准版 vs CoT 版两套提示词,用于对照实验)
 * 八股:09-Prompt工程.md §4.2 Zero-shot CoT(「Let's think step by step」的中文变体)
 *       09-Prompt工程.md §4.5 CoT 在 Agent 中的应用(用于多工具决策)
 *
 * 设计要点:
 * - 复用 v1_base 的所有 section,只追加 cotInstruction 字段
 * - 用对象 spread 而非 import 复用,确保两个版本可以独立演化(避免 v1_base 改动连带影响 v2)
 * - CoT 指令放在 system prompt 末尾,模型读完所有规则后再被引导"分步思考"
 * - 中文化 CoT:对齐我们的旅游 Agent 场景,把"思考维度"显式列出
 *   (偏好/约束/信息缺口/工具选择)——比裸 "请一步步想" 触发率更高
 */

import type { PromptTemplate } from './types.js'
import { v1Base } from './v1_base.js'

export const v2Cot: PromptTemplate = {
  ...v1Base,
  version: 'v2_cot',
  description: 'CoT 版:v1_base + Zero-shot Chain-of-Thought 触发指令',
  cotInstruction: `在给出回答或决定调用哪个工具之前,请先按以下顺序在心里逐步分析(不必输出推理过程):
1. 用户的核心偏好是什么(目的地特征、预算、节奏、主题)?
2. 已有的会话历史里有没有可以复用的上下文?
3. 当前信息是否足够给出有效建议——若不足,先按反问规则发起 [ASK_USER]。
4. 信息充分时,选择最匹配的可用工具获取数据(地图搜索、网页获取等)。
5. 整合工具结果,用简洁、可执行的语言回答。`
}
