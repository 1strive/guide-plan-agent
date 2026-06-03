/**
 * Task 4.2 — ReAct vs Plan-and-Execute 对比实验
 *
 * 规划:docs/开发规划.md Task 4.2
 * 八股:02-核心框架.md §3 Plan-and-Execute("ReAct vs P&E 怎么选"是高频面试题)
 *
 * 用法:
 *   npx tsx scripts/eval-plan-vs-react.ts
 *   npx tsx scripts/eval-plan-vs-react.ts --sleep 2000
 *
 * 跑 6 个有代表性的 case × 2 模式 = 12 次评测,记录:
 *   - 步骤数(tools.length;P&E 通常 1 次 plan + N tools + 1 次 synth;ReAct 是 N 轮 LLM 交错)
 *   - 总耗时 / token 消耗
 *   - 是否成功(passed 或至少 text 非空 + 无 error)
 * 输出 JSON + 控制台对比表。
 *
 * **选 case 的标准**:
 *   - 简单 1 步(detail-01 / web-01 / kw-01) → 看 P&E 是否过度规划(overhead)
 *   - 复杂多步(free-02 云南三日游 / 自定义 7 天云南游) → 看 P&E 是否真正提升
 *   - 反问类(ask-01) → P&E 通常不擅长反问(因为 plan 一次性生成)
 *   - 注入类(inj-01) → 验证安全规则在两种模式下都生效
 */

import { config as loadDotenv } from 'dotenv'
loadDotenv()
loadDotenv({ path: '.env.local', override: true })

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { McpManager } from '../src/mcp/client.js'
import { TEST_CASES, type TestCase } from '../src/eval/testset.js'
import { runForEval, type EvalMode, type EvalResult } from '../src/eval/runner.js'

// ── 对比用 case 清单 ──
// 从 testset 挑代表性的 case,再加一个 plan 模式应当胜出的复杂 case
const CASE_IDS = ['free-02', 'ask-01', 'inj-01', 'free-01'] as const

// 额外补一个"7 天云南游"复杂规划 case(planner 设计该擅长 vs ReAct 多轮)
const EXTRA_PLAN_FRIENDLY_CASE: TestCase = {
  id: 'plan-7day-yunnan',
  description: '复杂多步规划:7 天云南行程 + 美食 + 景点(plan 模式优势区)',
  category: 'free_form',
  message: '帮我规划一个 7 天的云南旅行行程,要包含丽江的美食和景点,按天分配。',
  expected: {
    // 不做硬性 tool/keyword 断言;主要看 duration / tokens / 步骤数
    shouldClarify: false
  }
}

function parseArgs(argv: string[]): { sleepMs: number } {
  let sleepMs = 1000
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sleep' && argv[i + 1]) {
      sleepMs = Number(argv[i + 1])
      i++
    }
  }
  return { sleepMs }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  const mcpManager = new McpManager(config)
  if (config.MCP_ENABLED) await mcpManager.init()
  const tools = mcpManager.getTools()

  const baseCases = CASE_IDS
    .map((id) => TEST_CASES.find((c) => c.id === id))
    .filter((c): c is TestCase => Boolean(c))
  if (baseCases.length !== CASE_IDS.length) {
    console.error('[eval] 部分 case 在 testset 找不到, 实际只跑:', baseCases.map((c) => c.id))
  }
  const cases: TestCase[] = [...baseCases, EXTRA_PLAN_FRIENDLY_CASE]

  console.log(
    `[eval-plan-vs-react] model=${config.OPENAI_MODEL} cases=${cases.length} sleep=${args.sleepMs}ms`
  )

  const allResults: EvalResult[] = []
  const modes: EvalMode[] = ['react', 'plan']

  for (const caseItem of cases) {
    for (const mode of modes) {
      try {
        const r = await runForEval(config, tools, caseItem, 'v1_base', mode)
        allResults.push(r)
        const ok = r.passed || (r.actual.text.length > 0 && !r.error)
        const tools = r.actual.tools.length === 0 ? '-' : r.actual.tools.join(',')
        console.log(
          `[${caseItem.id.padEnd(20)} | ${mode.padEnd(5)}] ` +
            `ok=${ok ? '✓' : '✗'} steps=${r.actual.tools.length} ` +
            `dur=${r.actual.durationMs}ms tokens=${r.actual.tokens} ` +
            `tools=[${tools}]`
        )
        if (r.error) console.log(`   error: ${r.error}`)
      } catch (err) {
        console.error(`[${caseItem.id} | ${mode}] crashed:`, err)
      }
      await sleep(args.sleepMs)
    }
  }

  // ── 对比汇总:同 case 两种模式横向 diff ──
  console.log('\n=== Compare Summary (per case) ===')
  console.log(
    'caseId'.padEnd(22) +
      ' | mode  | steps | duration(ms) | tokens | text-len'
  )
  console.log('-'.repeat(80))
  const byCase = new Map<string, EvalResult[]>()
  for (const r of allResults) {
    if (!byCase.has(r.caseId)) byCase.set(r.caseId, [])
    byCase.get(r.caseId)!.push(r)
  }
  for (const [caseId, list] of byCase) {
    for (const r of list) {
      console.log(
        `${caseId.padEnd(22)} | ${r.mode.padEnd(5)} | ${String(r.actual.tools.length).padEnd(5)} | ` +
          `${String(r.actual.durationMs).padEnd(12)} | ${String(r.actual.tokens).padEnd(6)} | ${r.actual.text.length}`
      )
    }
    if (list.length === 2) {
      const [a, b] = list[0].mode === 'react' ? [list[0], list[1]] : [list[1], list[0]]
      const stepDelta = b.actual.tools.length - a.actual.tools.length
      const durDelta = b.actual.durationMs - a.actual.durationMs
      const tokenDelta = b.actual.tokens - a.actual.tokens
      console.log(
        `${''.padEnd(22)} | Δplan-react   | ${(stepDelta > 0 ? '+' : '') + stepDelta} steps | ` +
          `${(durDelta > 0 ? '+' : '') + durDelta}ms | ${(tokenDelta > 0 ? '+' : '') + tokenDelta} tokens`
      )
      console.log('-'.repeat(80))
    }
  }

  // 模式聚合(平均值,直观看哪个模式整体快/省)
  console.log('\n=== Mode aggregate ===')
  for (const mode of modes) {
    const subset = allResults.filter((r) => r.mode === mode)
    if (subset.length === 0) continue
    const avgDuration = subset.reduce((s, r) => s + r.actual.durationMs, 0) / subset.length
    const avgTokens = subset.reduce((s, r) => s + r.actual.tokens, 0) / subset.length
    const avgSteps = subset.reduce((s, r) => s + r.actual.tools.length, 0) / subset.length
    const okCount = subset.filter((r) => r.passed || (r.actual.text.length > 0 && !r.error)).length
    console.log(
      `  ${mode.padEnd(6)} count=${subset.length} avgSteps=${avgSteps.toFixed(1)} ` +
        `avgDur=${avgDuration.toFixed(0)}ms avgTokens=${avgTokens.toFixed(0)} ok=${okCount}/${subset.length}`
    )
  }

  // ── JSON 报告 ──
  const outDir = path.resolve('docs/02-实验记录')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(outDir, `exp-05-plan-vs-react-${ts}.json`)
  const report = {
    ranAt: new Date().toISOString(),
    model: config.OPENAI_MODEL,
    temperature: config.LLM_TEMPERATURE,
    cases: cases.map((c) => ({ id: c.id, description: c.description })),
    modes,
    details: allResults
  }
  writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8')
  console.log(`\nreport: ${outFile}`)

  await mcpManager.shutdown()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
