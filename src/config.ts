import { z } from 'zod'

const dbEnvSchema = z.object({
  MYSQL_HOST: z.string().default('127.0.0.1'),
  MYSQL_PORT: z.coerce.number().default(3306),
  MYSQL_USER: z.string().default('root'),
  MYSQL_PASSWORD: z.string().default(''),
  MYSQL_DATABASE: z.string().default('guide_plan')
})

const envSchema = dbEnvSchema.extend({
  PORT: z.coerce.number().default(3000),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_BASE_URL: z.string().optional(),
  CHAT_HISTORY_LIMIT: z.coerce.number().default(30),
  RAG_TOP_K_DEFAULT: z.coerce.number().default(8),
  RAG_CANDIDATE_LIMIT: z.coerce.number().default(2000),
  LLM_MAX_TOOL_ROUNDS: z.coerce.number().default(10)
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

export function embeddingBaseUrl(config: AppConfig): string {
  return config.EMBEDDING_BASE_URL ?? config.OPENAI_BASE_URL
}
