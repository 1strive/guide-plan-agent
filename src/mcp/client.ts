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
import type { FastifyBaseLogger } from 'fastify'
import type { AppConfig } from '../config.js'

type StdioServerConfig = {
  transport: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
}

type HttpServerConfig = {
  transport: 'http'
  url: string
}

type McpServerConfig = StdioServerConfig | HttpServerConfig
type McpServersConfig = Record<string, McpServerConfig>

export class McpManager {
  private client: MultiServerMCPClient | null = null
  private tools: StructuredToolInterface[] = []

  constructor(private config: AppConfig, private log?: FastifyBaseLogger) { }

  async init(): Promise<void> {
    const mcpServers: McpServersConfig = {}

    // 1. @modelcontextprotocol/server-puppeteer — 浏览器自动化(导航/截图/点击/执行JS)
    mcpServers['puppeteer'] = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer']
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

    // 3. 高德地图 MCP — Streamable HTTP 方式(推荐,无需本地 npx / Node 版本要求)
    //    文档:https://lbs.amap.com/api/mcp-server/gettingstarted
    if (this.config.MCP_AMAP_API_KEY) {
      mcpServers['amap'] = {
        transport: 'http',
        url: `https://mcp.amap.com/mcp?key=${this.config.MCP_AMAP_API_KEY}`
      }
    }

    this.log?.info({ mcpServers }, 'MCP servers config')

    this.client = new MultiServerMCPClient({
      throwOnLoadError: false,
      prefixToolNameWithServerName: false,
      onConnectionError: 'ignore',
      mcpServers
    })

    this.tools = await this.client.getTools()
    this.log?.info({ tools: this.tools.map(t => t.name) }, 'MCP tools loaded')
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
