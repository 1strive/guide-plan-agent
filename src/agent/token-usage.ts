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
