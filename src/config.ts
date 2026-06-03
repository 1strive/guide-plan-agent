import { z } from 'zod'

const dbEnvSchema = z.object({
  MYSQL_HOST: z.string().default('127.0.0.1'),
  MYSQL_PORT: z.coerce.number().default(3306),
  MYSQL_USER: z.string().default('root'),
  MYSQL_PASSWORD: z.string().default(''),
  MYSQL_DATABASE: z.string().default('guide_plan')
})

/**
 * Task 1.1 / Task 1.2 — 推理参数与成本配置
 *
 * 规划:docs/开发规划.md Task 1.1(理解 temperature/max_tokens 对输出影响)、Task 1.2(成本控制)
 * 八股:docs/01-面试八股文/09-Prompt工程.md §2.4 迭代优化、08-工程化实践.md §2 Token 成本控制
 *
 * 配置语义速记:
 * - LLM_TEMPERATURE:采样温度,越低越稳定,推荐场景 0.2~0.5
 * - LLM_MAX_TOKENS:单次响应 token 上限,直接关联成本与截断风险
 * - LLM_TOP_P:核采样,与 temperature 二选一调,通常保持 1
 * - LLM_REQUEST_TIMEOUT_MS:fetch 总超时,八股 08 §1 强调外部调用必须有超时
 * - MODEL_PRICE_INPUT_PER_1K / MODEL_PRICE_OUTPUT_PER_1K:按千 token 计价(美元),
 *   配合 Task 1.2 的 usage 输出 cost_usd 日志(八股 08 §2.5 的最小可行实现)
 */
const envSchema = dbEnvSchema.extend({
  PORT: z.coerce.number().default(3000),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  CHAT_HISTORY_LIMIT: z.coerce.number().default(30),
  LLM_MAX_TOOL_ROUNDS: z.coerce.number().default(10),
  LLM_TEMPERATURE: z.coerce.number().default(0.4),
  LLM_MAX_TOKENS: z.coerce.number().default(2048),
  LLM_TOP_P: z.coerce.number().default(1),
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().default(60_000),
  MODEL_PRICE_INPUT_PER_1K: z.coerce.number().default(0),
  MODEL_PRICE_OUTPUT_PER_1K: z.coerce.number().default(0),
  // Task 2.1:Prompt 版本切换
  PROMPT_VERSION: z.string().default('v1_base'),
  // Task 4.4:MCP 总开关 + 各 server 配置
  MCP_ENABLED: z.coerce.boolean().default(true),
  MCP_AMAP_API_KEY: z.string().default(''),
  MCP_FILESYSTEM_ALLOWED_DIRS: z.string().default(''),
  // Task 4.3:记忆分层 — 会话消息数超过此阈值时触发 LLM 摘要
  MEMORY_SUMMARY_THRESHOLD: z.coerce.number().default(20)
})

export type AppConfig = z.infer<typeof envSchema>
export type DbConfig = z.infer<typeof dbEnvSchema>

export function loadDbConfig(): DbConfig {
  const parsed = dbEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new Error(`Invalid DB env: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`)
  }
  return parsed.data
}

export function loadConfig(): AppConfig {
  if (!process.env.OPENAI_API_KEY && process.env.API_KEY) {
    process.env.OPENAI_API_KEY = process.env.API_KEY
  }
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new Error(`Invalid env: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`)
  }
  return parsed.data
}

