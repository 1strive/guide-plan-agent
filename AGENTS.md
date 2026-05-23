# AGENTS.md

## Setup commands
- Npm package management tool using tnpm
- Install deps: `tnpm install`
- 本地 MySQL（Docker）：复制 `.env.example` 为 `.env`，按需修改 `OPENAI_API_KEY`；执行 `npm run docker:up` 启动容器（映射 `3307`，避免占用本机已有 `3306`）。待容器健康后依次：`npx tsx scripts/migrate.ts`、`npx tsx scripts/seed.ts`；启动服务：`npm run dev`（默认端口见 `.env`）。

## Code style
- TypeScript strict mode
- Single quotes, no semicolons
- Use functional patterns where possible
- Generate commit message information needs to be in Chinese

## 学习项目专属注释规则（重要）

> 本项目同时承担「按 `docs/开发规划.md` 推进开发」与「面试备战」两个目标。注释的首要价值是让代码与学习材料形成可追溯的双向链接,**和通用 TS 项目「默认不写注释」的原则相反**:这里要求每一处源于规划任务或面试考点的实现,都必须打上关联注释。

### 何时必须加注释
- **新增/重构**了 `docs/开发规划.md` 中某个 Task 涉及的代码(模块、函数、关键分支、配置项)。
- 实现了 `docs/01-面试八股文/` 某条考点对应的工程做法(例如指数退避、token 计数、语义缓存、混合检索)。
- 做了非显然的工程决策,且该决策在八股文里有对应解释(例如「流式响应必须显式声明 `stream_options.include_usage`」)。

### 注释格式

**(A) 模块/函数顶部:块注释**——用于新增的文件、对外导出的函数、重要的类型定义。

```ts
/**
 * Task 1.2 — Token 计数与成本控制
 *
 * 规划:docs/开发规划.md Task 1.2(输出物:带用量统计的日志、单条请求成本笔记)
 * 八股:docs/01-面试八股文/08-工程化实践.md §2 Token 成本控制(§2.5 含 tiktoken 计数代码示例)
 *
 * 实现要点:
 * - 流式响应需声明 stream_options.include_usage,否则 usage 字段不会下发
 * - 每轮 LLM 调用累加 prompt/completion tokens,run_finished 时统一打日志
 */
```

**(B) 关键行:行注释**——用于函数内部某个非显然的判断、参数、绕坑点。

```ts
// Task 1.1 / 八股 09 §2.4: temperature 越低输出越稳定,旅游推荐场景用 0.4 平衡多样性与一致性
temperature: config.LLM_TEMPERATURE
```

```ts
// 八股 08 §1.2: 客户端断开后必须 abort,否则 LLM 与下游工具仍会继续消耗 token
req.raw.on('close', () => controller.abort())
```

### 引用语法约定
- 规划引用:`docs/开发规划.md Task X.Y`
- 八股引用:`docs/01-面试八股文/NN-文件名.md §章号` 或简写 `八股 NN §章号`(在已有上下文里清晰即可)
- 多个关联点用逗号或换行分隔,确保面试时能 grep `Task X.Y` 或 `八股 NN` 一键跳到代码现场。

### 不需要打的注释
- 只是修语法、改风格、重命名变量、调整格式——这些与规划/八股无关。
- 业务字段含义、显而易见的赋值——保持「无注释默认」。
- 已经被块注释覆盖的同一函数内部细节——避免冗余。

### 自检
提交前快速 grep 一遍:对当前 commit 涉及的每个 Task,是否在代码里能 `grep "Task X.Y"` 找到对应实现?如果找不到,补上头注释。
