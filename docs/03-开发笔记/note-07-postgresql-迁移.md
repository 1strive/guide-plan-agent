# PostgreSQL 全栈迁移笔记（2026-06-24，代码改动速查）

> **本文目标**：记录把项目数据库从 MySQL 全栈迁移到 PostgreSQL 的每一处代码改动，
> 未来回看时能直接跳到对应文件，不用逆向猜实现。
>
> **配套文档**：架构总图 [`docs/04-架构文档/agent-架构.md`](../04-架构文档/agent-架构.md)（§1.1 分层图 / §1.2 模块表 / §5.7-§5.8 Checkpointer 决策 / §6 局限表已同步）。
>
> **覆盖范围**：数据库驱动切换 ✅ / Checkpointer 持久化 ✅
>
> **核心动机**：LangGraph 官方提供 `PostgresSaver`，一个 PostgreSQL 库可同时承担
> 「业务存储 + checkpoint 持久化」；项目未上线无数据迁移成本，SQL 使用标准无 MySQL 专属依赖。

---

## 1. 为什么这么做（STAR）

- **S（背景）**：Checkpointer 一直用 `MemorySaver`（进程内 Map），重启即丢，interrupt 状态无法真实恢复；而 LangGraph 官方持久化 Saver 首推 PostgreSQL。
- **T（目标）**：整库切 PostgreSQL，让 `PostgresSaver` 复用业务连接池，业务表与 checkpoint 表同库，进程重启后图状态可 `Command(resume)` 恢复。
- **A（动作）**：换驱动（`mysql2`→`pg`）、改容器、改配置、重写 5 个迁移 SQL 为 PG 语法、重写两个 Repo 的占位符与结果解构、`MemorySaver`→`PostgresSaver` + 启动 `setup()` 建表。
- **R（结果）**：`npx tsc --noEmit` 0 错误；全项目无 `mysql2` / `MYSQL_` 代码残留（仅注释历史描述保留）。

---

## 2. 总览（Task → 一句话 → 新增/改动文件）

| 改动点 | 一句话 | 新增文件 | 改动文件 |
| --- | --- | --- | --- |
| 依赖 | `mysql2` → `pg` + `@types/pg` + `@langchain/langgraph-checkpoint-postgres` | — | `package.json` |
| 容器 | MySQL(3307) → `postgres:16-alpine`(5433) | — | `docker-compose.yml` |
| 配置 | `MYSQL_*` → `PG_*` | — | `.env` / `.env.example` / `src/config.ts` |
| 连接池 | `mysql2` Pool → `pg.Pool`，`query` 返回 `{rows,rowCount}` | — | `src/db/pool.ts` |
| 迁移 SQL | MySQL 语法 → PG 语法（BIGSERIAL/TEXT/JSONB/CHECK） | — | `migrations/001~006.sql` |
| 迁移脚本 | 先连 `postgres` 库查 `pg_database` 再建库 | — | `scripts/migrate.ts` |
| 数据访问 | `?`→`$n`、`RETURNING`、`ON CONFLICT`、`rowCount`、bigint→Number | — | `src/db/chatRepo.ts` / `src/db/runRepo.ts` |
| Checkpoint | `MemorySaver` → `PostgresSaver` + 启动 `initCheckpointer` | — | `src/agent/langgraph-agent.ts` / `src/index.ts` |

---

## 3. 关键改动详解

### 3.1 连接池 `src/db/pool.ts`

`pg.Pool` 替代 `mysql2`，`DbPool` 类型（全项目引用）改为 `pg.Pool`。这样
`PostgresSaver` 能直接复用同一个 Pool。

```ts
import pg from 'pg'
export function createPool(config: AppConfig | DbConfig): pg.Pool {
  return new pg.Pool({
    host: config.PG_HOST, port: config.PG_PORT, user: config.PG_USER,
    password: config.PG_PASSWORD, database: config.PG_DATABASE, max: 10
  })
}
export type DbPool = pg.Pool
```

**边界**：`pg` 的 `query()` 返回 `{ rows, rowCount }`，不再是 mysql2 的 `[rows, fields]` 解构 —— 所有调用方随之改写（见 3.4）。

### 3.2 迁移脚本 `scripts/migrate.ts`

PostgreSQL 不支持 `CREATE DATABASE IF NOT EXISTS`，需先连默认 `postgres` 库查
`pg_database`，不存在再建；随后连目标库顺序执行 SQL。

```ts
const admin = new pg.Client({ ...conn, database: 'postgres' })
await admin.connect()
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.PG_DATABASE])
if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${config.PG_DATABASE}"`)
```

**边界**：库名不能参数化，只能拼接（用双引号包裹）。迁移幂等不再依赖 MySQL 错误码 1050/1060，改由每个 SQL 文件自带 `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` 保证。

### 3.3 迁移 SQL `migrations/001~006.sql`

MySQL → PostgreSQL 语法差异总表（面试高频）：

| MySQL | PostgreSQL |
| --- | --- |
| `AUTO_INCREMENT` | `BIGSERIAL` |
| `INT UNSIGNED` | `INT` |
| `MEDIUMTEXT` | `TEXT` |
| `ENUM(...)` | `VARCHAR + CHECK` |
| `JSON` | `JSONB` |
| `TIMESTAMP` | `TIMESTAMPTZ` |
| `KEY idx (...)` 内联索引 | `CREATE INDEX` 独立语句 |
| `ENGINE=InnoDB` / `CHARSET` / 反引号 | 全部移除 |

### 3.4 数据访问层 `src/db/chatRepo.ts` / `src/db/runRepo.ts`

四类改写：

1. **占位符**：`?` → `$1, $2 ...`（`bulkInsertArchivedEvents` 用 `let i=1` 递增拼 `$i`）
2. **结果解构**：`const [rows] = await pool.query(...)` → `const { rows } = await pool.query(...)`
3. **自增主键**：mysql2 `insertId` → `RETURNING id`
   ```ts
   const { rows } = await pool.query(
     "INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'assistant', '') RETURNING id", [sessionId])
   return Number((rows[0] as { id: number | string }).id)
   ```
4. **影响行数 / 幂等写 / bigint**：`affectedRows` → `rowCount ?? 0`；`INSERT IGNORE` → `ON CONFLICT (run_id, seq) DO NOTHING`；pg 把 `bigint`/`COUNT(*)` 返回为字符串，用 `Number()` 转（`runRepo.ts` 抽了 `normalizeRunRow()` 统一处理，`chatRepo.listSessions` 手动转 `totalTokens`/`messageCount`）。
   ```ts
   await pool.query(
     `INSERT INTO archived_run_events (run_id, seq, event_json)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (run_id, seq) DO NOTHING`, values)
   ```

**边界**：列别名要保留驼峰必须用双引号，如 `total_tokens AS "totalTokens"`（PG 默认把无引号标识符转小写）。

### 3.5 Checkpointer `src/agent/langgraph-agent.ts` + `src/index.ts`

`MemorySaver` → `PostgresSaver`，复用业务 `pg.Pool`；启动时调 `setup()` 自动建
`checkpoints` / `checkpoint_writes` / `checkpoint_blobs` 三张表。

```ts
// langgraph-agent.ts
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
let checkpointer: PostgresSaver | undefined
export async function initCheckpointer(pool: DbPool): Promise<void> {
  const saver = new PostgresSaver(pool)
  await saver.setup()          // 首次运行自动建 checkpoint 三表
  checkpointer = saver
}
```

```ts
// index.ts main()：listen 前初始化一次
const pool = createPool(config)
await initCheckpointer(pool)
```

**设计决策**：图状态现已持久化，但项目层「重挂 stream + subscriber」仍未自动做，
所以重启仍把 running 标 failed（详见架构文档 §5.7）。**图状态可恢复 ≠ 业务事件流自动重挂**，二者是分离的两套持久化。

---

## 4. 八股文映射

- **05-记忆系统.md**：checkpoint 是「短期记忆 / 会话状态」的持久化载体；本次是该考点在项目中**从进程内存升级到持久化存储的首次实践**（`MemorySaver` → `PostgresSaver`）。
- **08-工程化实践.md §2.2.3 缓存策略 / §4 缓存与热层**：数据库选型（PostgreSQL JSONB / UPSERT / MVCC）与 Redis 热层的冷热分层配合。
- **通用工程**：MySQL vs PostgreSQL 语法差异（见 §3.3）、`ON CONFLICT` 幂等写、`RETURNING` 拿自增主键 —— 均为数据库层高频面试点。

---

## 5. 验证命令

```bash
npx tsc --noEmit                              # 类型检查（0 错误）
grep -rn "mysql2\|MYSQL_\|RowDataPacket" src scripts   # 确认无代码残留（仅注释保留历史描述）

npm run docker:up                             # 启动 PostgreSQL 容器
npx tsx scripts/migrate.ts                    # 建库 + 执行迁移
npm run dev                                   # 启动服务，PostgresSaver 首次 setup() 建 checkpoint 表
```
