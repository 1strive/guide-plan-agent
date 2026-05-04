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
