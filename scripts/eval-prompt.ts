/**
 * Task 2.3 — Prompt 评测批量执行脚本
 *
 * 规划:docs/开发规划.md Task 2.3(批量跑不同版本提示词,输出通过率与失败 case)
 * 八股:09-Prompt工程.md §2.4 迭代优化、08-工程化实践.md §7 评估与测试
 *
 * 用法:
 *   npx tsx scripts/eval-prompt.ts                         # 评全部已注册版本 × 全部 case
 *   npx tsx scripts/eval-prompt.ts --version v1_base       # 只评单个版本(可重复)
 *   npx tsx scripts/eval-prompt.ts --case ask-01,kw-01     # 只跑指定 case
 *   npx tsx scripts/eval-prompt.ts --sleep 2000            # 调整 case 间隔(默认 1000ms)
 *
 * 实现要点:
 * - 串行执行:避免并发打爆 LLM rate limit,每 case 间 sleep 默认 1s
 * - knownFail 单独计数:依赖未实现工具(如 semantic_search_travel)的 case 不计入硬失败
 * - 输出双份:控制台摘要(快速反馈) + JSON 报告(可纳入 git 做版本对比)
 */

import { config as loadDotenv } from 'dotenv'
loadDotenv()
loadDotenv({ path: '.env.local', override: true })

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db/pool.js'
import { listPromptVersions } from '../src/agent/prompts/index.js'
import { TEST_CASES, type TestCase } from '../src/eval/testset.js'
import { runForEval, type EvalResult } from '../src/eval/runner.js'

type Args = {
  versions: string[]
  caseIds?: string[]
  sleepMs: number
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const versions: string[] = []
  let caseIds: string[] | undefined
  let sleepMs = 1000
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--version' && argv[i + 1]) {
      versions.push(argv[++i]!)
    } else if (a === '--case' && argv[i + 1]) {
      caseIds = argv[++i]!.split(',').map((s) => s.trim()).filter(Boolean)
    } else if (a === '--sleep' && argv[i + 1]) {
      sleepMs = Number(argv[++i]) || 1000
    }
  }
  return {
    versions: versions.length > 0 ? versions : listPromptVersions(),
    caseIds,
    sleepMs
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function fmtCheck(v: boolean | null): string {
  if (v === null) return ' - '
  return v ? ' ✓ ' : ' ✗ '
}

async function main(): Promise<void> {
  const args = parseArgs()
  const config = loadConfig()
  const pool = createPool(config)

  const cases: TestCase[] = args.caseIds
    ? TEST_CASES.filter((c) => args.caseIds!.includes(c.id))
    : TEST_CASES

  if (cases.length === 0) {
    console.error('[eval] no cases matched, exit')
    await pool.end()
    process.exit(1)
  }

  console.log(
    `[eval] model=${config.OPENAI_MODEL} versions=${args.versions.join(',')} cases=${cases.length} sleep=${args.sleepMs}ms`
  )

  const allResults: EvalResult[] = []
  for (const version of args.versions) {
    for (const caseItem of cases) {
      const prefix = `[${version}/${caseItem.id}]`
      try {
        const result = await runForEval(pool, config, caseItem, version)
        allResults.push(result)
        const tag = result.passed ? '✓' : (result.knownFail ? '~' : '✗')
        console.log(
          `${prefix} ${tag} tool=${fmtCheck(result.checks.tool)} kw=${fmtCheck(result.checks.keywords)} clarify=${fmtCheck(result.checks.clarification)} refuse=${fmtCheck(result.checks.refused)} tokens=${result.actual.tokens} ${result.actual.durationMs}ms`
        )
        if (!result.passed && !result.knownFail) {
          console.log(
            `${prefix}   tools=[${result.actual.tools.join(',')}] text="${result.actual.text.slice(0, 120).replace(/\n/g, ' ')}"`
          )
        }
        if (result.error) {
          console.log(`${prefix}   error: ${result.error}`)
        }
      } catch (err) {
        console.error(`${prefix} crashed:`, err)
      }
      await sleep(args.sleepMs)
    }
  }

  // ── 汇总 ──
  type Summary = {
    total: number
    passed: number
    failed: number
    knownFail: number
    hardFailRate: number
  }
  const summary: Record<string, Summary> = {}
  for (const version of args.versions) {
    const subset = allResults.filter((r) => r.promptVersion === version)
    const passed = subset.filter((r) => r.passed).length
    const knownFail = subset.filter((r) => !r.passed && r.knownFail).length
    const failed = subset.length - passed - knownFail
    summary[version] = {
      total: subset.length,
      passed,
      failed,
      knownFail,
      hardFailRate:
        subset.length > 0
          ? Number((failed / subset.length).toFixed(3))
          : 0
    }
  }

  console.log('\n=== Summary ===')
  for (const [v, s] of Object.entries(summary)) {
    console.log(
      `  ${v.padEnd(10)} pass=${s.passed}/${s.total} fail=${s.failed} knownFail=${s.knownFail} hardFailRate=${(s.hardFailRate * 100).toFixed(1)}%`
    )
  }

  // ── JSON 报告 ──
  const outDir = path.resolve('docs/02-实验记录')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(outDir, `exp-02-prompt-versions-${ts}.json`)
  const report = {
    ranAt: new Date().toISOString(),
    model: config.OPENAI_MODEL,
    temperature: config.LLM_TEMPERATURE,
    topP: config.LLM_TOP_P,
    versions: args.versions,
    summary,
    details: allResults
  }
  writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8')
  console.log(`\nreport: ${outFile}`)

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
