import type { AppConfig } from '../config.js'

export type TokenUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

// 字符数粗略估算 token（保守上界）
// 中文约 1 字 = 1.5~2 token，英文约 4 字符 = 1 token
// 简单取 length / 2 作为上界
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

// 合并多轮 usage
export function accumulateUsage(base: TokenUsage | null, next: TokenUsage): TokenUsage {
  return {
    promptTokens: (base?.promptTokens ?? 0) + next.promptTokens,
    completionTokens: (base?.completionTokens ?? 0) + next.completionTokens,
    totalTokens: (base?.totalTokens ?? 0) + next.totalTokens
  }
}

/**
 * Task 1.2 / 4.1.C — 按 MODEL_PRICE_INPUT_PER_1K / OUTPUT_PER_1K 算 cost(USD)
 *
 * 八股:08-工程化实践.md §2 Token 成本控制
 *
 * 默认价格 0(`.env.example` 默认值)→ 返回 0,日志里仍出 costUsd 字段但是 0;
 * 配置真实价格后 finalize 的 run summary 自动开始反映成本。
 */
export function computeCostUsd(usage: TokenUsage, config: AppConfig): number {
  return (
    (usage.promptTokens / 1000) * config.MODEL_PRICE_INPUT_PER_1K +
    (usage.completionTokens / 1000) * config.MODEL_PRICE_OUTPUT_PER_1K
  )
}
