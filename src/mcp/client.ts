/**
 * Task 4.4 — MCP 客户端管理器
 *
 * 规划:docs/开发规划.md Task 4.4
 * 八股:04-工具调用.md §6 MCP 协议 / 02-核心框架.md §Tool ecosystems
 *
 * 用 @langchain/mcp-adapters 的 MultiServerMCPClient 管理多个 MCP Server 生命周期。
 * init() 启动所有配置的 server → getTools() 返回 LangChain StructuredTool[] → shutdown() 清理。
 *
 * 设计要点:
 * - 按 config 动态决定启用哪些 server(无 API key = 不启动)
 * - onConnectionError: 'ignore' — 单个 server 挂不影响其他
 * - fetch server 始终启动(无需 API key,通用性强)
 */

import { MultiServerMCPClient } from '@langchain/mcp-adapters'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AppConfig } from '../config.js'

type StdioServerConfig = {
  transport: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
}

type McpServersConfig = Record<string, StdioServerConfig>

export class McpManager {
  private client: MultiServerMCPClient | null = null
  private tools: StructuredToolInterface[] = []

  constructor(private config: AppConfig) {}

  async init(): Promise<void> {
    const mcpServers: McpServersConfig = {}

    // 1. @anthropic/mcp-server-fetch — 通用网页抓取,始终启用
    mcpServers['fetch'] = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic/mcp-server-fetch']
    }

    // 2. @modelcontextprotocol/server-filesystem — 本地文件访问
    if (this.config.MCP_FILESYSTEM_ALLOWED_DIRS) {
      const dirs = this.config.MCP_FILESYSTEM_ALLOWED_DIRS.split(',').map(d => d.trim()).filter(Boolean)
      if (dirs.length > 0) {
        mcpServers['filesystem'] = {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', ...dirs]
        }
      }
    }

    // 3. 高德地图 MCP — POI 搜索、天气、路线规划
    if (this.config.MCP_AMAP_API_KEY) {
      mcpServers['amap'] = {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@amap/amap-maps-mcp-server'],
        env: { AMAP_MAPS_API_KEY: this.config.MCP_AMAP_API_KEY }
      }
    }

    this.client = new MultiServerMCPClient({
      throwOnLoadError: false,
      prefixToolNameWithServerName: false,
      onConnectionError: 'ignore',
      mcpServers
    })

    this.tools = await this.client.getTools()
  }

  getTools(): StructuredToolInterface[] {
    return this.tools
  }

  getToolNames(): string[] {
    return this.tools.map(t => t.name)
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.close()
      this.client = null
      this.tools = []
    }
  }
}
