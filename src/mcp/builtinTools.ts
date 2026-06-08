/**
 * 内置工具 — 不依赖外部服务的轻量 LangChain tools
 *
 * 这些工具直接注册到 createAgent,跟 MCP / FlyAI 工具合并使用。
 */

import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { StructuredToolInterface } from '@langchain/core/tools'

const getCurrentTime = tool(
  async () => {
    const now = new Date()
    return JSON.stringify({
      iso: now.toISOString(),
      date: now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }),
      time: now.toLocaleTimeString('zh-CN', { hour12: false }),
      weekday: now.toLocaleDateString('zh-CN', { weekday: 'long' }),
      timestamp: now.getTime()
    })
  },
  {
    name: 'get_current_time',
    description: '获取当前日期和时间(含星期几)。当用户提到"今天""明天""下周""这个月"等相对时间,或需要判断日期是否合理时,调用此工具获取准确时间。',
    schema: z.object({})
  }
)

export function createBuiltinTools(): StructuredToolInterface[] {
  return [
    getCurrentTime as unknown as StructuredToolInterface
  ]
}
