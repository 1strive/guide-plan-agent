/**
 * Task 2.1 — 提示词模板类型定义
 *
 * 规划:docs/开发规划.md Task 2.1(从单字符串改为模板引擎 + 多版本)
 * 八股:docs/01-面试八股文/09-Prompt工程.md §1.3 Prompt 基本结构(角色/任务/约束/输出格式)
 *
 * 设计原则:
 * - section 化:把 system prompt 拆为 role / taskScope / 规则块,
 *   render 时按固定顺序拼接 → 多版本之间结构对齐,面试时能讲清楚"我改了哪一段"
 * - 变量插值:用 {{name}} 占位,给 Task 4.3 注入记忆摘要、用户画像预留接口
 * - examples:Few-shot 示例以 user/assistant 对话形式给(八股 09 §3.5),
 *   不塞进 system 字符串,而是独立返回 prependMessages 数组,模型理解更稳
 */

export type FewShotExample = {
  user: string
  assistant: string
}

export type PromptTemplate = {
  // 版本标识(对应 prompts/index.ts registry 的 key,如 'v1_base' / 'v2_cot');
  // config.PROMPT_VERSION 与请求体 promptVersion 字段都按此值匹配
  version: string
  // 一句话描述本版本的设计意图,便于注册表、评测报告、面试讲故事时快速识别
  description: string
  // 角色身份(对应八股 09 §1.3 角色段):"你是…",定义模型扮演的人格
  role: string
  // 任务边界/元说明;本项目还兼用作"防示例污染"声明
  // (见 docs/02-实验记录/exp-02 第 2 轮 / docs/03-开发笔记/note-02 §5.3)
  taskScope?: string
  // 工具调用规则:决定模型应该调哪个工具(对应 src/agent/tools.ts 里注册的 function),
  // render 时会自动编号 + 加 "工具调用规则:" 小标题
  toolUsageRules?: string[]
  // 输出格式约束:限制回答的形式(如"不要堆 JSON"、"标注目的地 id"等)
  outputFormat?: string[]
  // 上下文使用规则:指代消解("按刚才说的")、历史利用、何时总结偏好等
  contextRules?: string[]
  // 反问规则:含 [ASK_USER] 协议(见 src/agent/llm.ts:parseAskUser),
  // 教模型在信息不足时主动反问 + 提供【选项】列表
  clarificationRules?: string[]
  // 安全防御规则(八股 09 §8):防 Prompt 注入指令,告诉模型把可疑文本当数据;
  // 配合 src/agent/sanitize.ts 的入口检测 + <untrusted_user_content> 包裹形成双层防御。
  // 所有版本都应填,作为 strong default 而非可选安全
  securityRules?: string[]
  // Task 2.2:Few-shot 示例,render 时转为 user/assistant 消息(八股 09 §3.5),
  // 不塞 system 文本而独立返回 prependMessages
  examples?: FewShotExample[]
  // Task 2.2:CoT 触发指令(八股 09 §4.2 Zero-shot CoT),追加在 system 末尾;
  // 当前仅 v2_cot 启用,空值时不输出 CoT 段落
  cotInstruction?: string
  // 文档性字段:声明本模板支持哪些 {{var}} 插值变量(给 Task 4.3 记忆摘要/用户画像预留)
  variables?: string[]
}

export type RenderedPrompt = {
  // 渲染好的 system prompt 完整文本(各 section 按固定顺序拼接 + 变量插值后的结果)
  system: string
  // Few-shot 示例展开成的 user/assistant 消息数组,排在 system 之后、真实 history 之前
  prependMessages: Array<{ role: 'user' | 'assistant'; content: string }>
}
