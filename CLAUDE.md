# CLAUDE.md

> Claude Code 在本项目每次会话启动时会自动加载本文件。本文件的作用是把项目规范集中指过去,**真正的规则原文请看 [AGENTS.md](./AGENTS.md)**——人和其他 AI 工具读 AGENTS.md,Claude Code 通过本文件被引导到同一份规则,避免双源漂移。

## 必读规范

- 项目命令、代码风格、提交信息约定:见 [AGENTS.md - Setup commands / Code style](./AGENTS.md)
- **学习项目专属注释规则(强制)**:见 [AGENTS.md - 学习项目专属注释规则](./AGENTS.md#学习项目专属注释规则重要)
- **架构文档同步规则(强制)**:改核心模块后必须回核 [docs/04-架构文档/agent-架构.md](./docs/04-架构文档/agent-架构.md);详见 [AGENTS.md - 架构文档同步规则](./AGENTS.md#架构文档同步规则强制)
- 开发节奏与任务编号:见 [docs/开发规划.md](./docs/开发规划.md)
- 面试考点对照表:见 [docs/01-面试八股文/](./docs/01-面试八股文/)

## 注释规则速记(展开请看 AGENTS.md 原文)

按 `docs/开发规划.md` 推进开发时,**每一处源于规划 Task 或面试考点的实现都必须打关联注释**:

- 块注释(模块/函数顶部):
  - `规划:docs/开发规划.md Task X.Y`
  - `八股:docs/01-面试八股文/NN-文件名.md §章号`
- 行注释(关键判断点):`Task X.Y / 八股 NN §章号:<一句解释>`
- 这是本项目刻意偏离「默认不写注释」原则的部分——注释是代码与学习材料的双向链接。

## 提交前自检

- `grep -rn "Task X.Y" src/` 能否定位到本次相关实现?
- 改动是否同时更新了相关八股引用(若新增/重构涉及考点)?
- 改动涉及 HTTP 路由 / `runAgentStream` / `prompts/` / `tools.ts` / `chatRepo.ts` / abort 行为等 — 是否回核 `docs/04-架构文档/agent-架构.md` 相关章节?(无需更新也请显式说明)
- **改动涉及 `ag-ui.ts` 新增/修改事件类型 或 HTTP 接口响应结构变化 — 是否同步更新 `docs/03-开发笔记/note-05-AG-UI协议文档.md`?**(前端依赖此文档做渲染适配)
- 类型检查通过:`npx tsc --noEmit`
