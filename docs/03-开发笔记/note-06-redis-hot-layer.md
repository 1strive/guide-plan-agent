# Redis 热层改造笔记(Task 5.4)

> **任务范围**:把 `agent_run_events` 高频写入 + 续订查询从 MySQL 迁移到 Redis Stream;Run 终态时全段归档到 `archived_run_events` 冷库;Pub/Sub 频道为跨进程广播预留(本期订阅端不接)。
>
> **方案**:渐进型方案 B —— 状态机 / 业务表继续 MySQL,只迁事件流。
>
> **关键产出**:`src/redis/{pool,runEventStore}.ts`、`src/db/migrations/006_archived_run_events.sql`、`src/agent/runManager.ts` 5 处改造、`docker-compose.yml` 加 redis:7-alpine。

---

## 1. 为什么这么做(STAR)

- **S(背景)**:阅读 `agent_run_events` 在 MySQL,每个 token 一行 INSERT,流式响应几百行很常见;阅读生命期 < 1h(前端续订完就不再查)。
- **T(目标)**:把高频写从 MySQL 卸下来,降低主库压力;同时不破坏 `?after_seq=N` 续订接口的 seq 语义。
- **A(动作)**:
  1. 抽 `src/redis/runEventStore.ts` 5 个函数(`appendEvent` / `queryEventsAfter` / `streamExists` / `archiveAndCleanup` / `listOrphanRuns`)封装 Stream + Pub/Sub
  2. XADD 用 `{seq}-0` 显式 ID 让 Redis 拒乱序写,seq 沿用 `RunHandle.seqCounter` 应用层自增
  3. `subscribe` 改双源读取:`streamExists` → Redis;否则走 `archived_run_events`
  4. `finalize` 调 `archiveAndCleanup`:全段 XRANGE → INSERT IGNORE 冷库 → EXPIRE 1h(不 DEL)
  5. `cleanupOnStartup` 加 `listOrphanRuns` SCAN 兜底(归档失败 / 进程崩溃后重启重试)
- **R(结果)**:tsc 编译通过;主库读写脱敏;前端续订接口 0 改动。

---

## 2. 代码改动速查

### 2.1 新增文件

| 文件                                            | 内容                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/redis/pool.ts`                             | ioredis 单例 + `createRedis(url)` / `closeRedis()`                                                              |
| `src/redis/runEventStore.ts`                    | 5 个核心函数;`STREAM_KEY = 'run:{runId}:events'` / `CHANNEL_KEY = 'run:{runId}:channel'` / `STREAM_FIELD = 'e'` |
| `src/db/migrations/006_archived_run_events.sql` | 冷库表;FK CASCADE 到 `agent_runs(run_id)`                                                                       |

### 2.2 修改文件

| 文件                      | 变更点                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`      | 加 `redis:7-alpine` 服务,port `6380:6379`,AOF everysec,volume `guide_redis`                                                                                     |
| `package.json`            | `ioredis ^5.4.1`                                                                                                                                                |
| `src/config.ts`           | `REDIS_URL` / `REDIS_EVENT_TTL_SEC`(默认 3600s)                                                                                                                 |
| `.env.example`            | 同上两项                                                                                                                                                        |
| `src/db/runRepo.ts`       | **删** `appendEvent` / `queryEventsAfter`;**加** `bulkInsertArchivedEvents` / `queryArchivedEventsAfter` / `updateRunLastEventSeq`                              |
| `src/agent/runManager.ts` | 构造函数加 `redis: RedisClient` 参数;`handleEvent` 改 `redisAppendEvent`;`subscribe` 双源读取;`finalize` 调 `archiveAndCleanup`;`cleanupOnStartup` 加 SCAN 兜底 |
| `src/index.ts`            | `createRedis(config.REDIS_URL)` + 注入 `RunManager`;SIGTERM 链路加 `closeRedis()`;`/health` 并入 PING                                                           |

---

## 3. 关键设计点(八股映射)

### 3.1 XADD `{seq}-0` 显式 ID(八股 08 §4 缓存与并发)

**为什么**:Redis Stream 默认按服务器时间生成 ID(`*`),并发写时 Stream 自身保证单调,但**应用层 seq 跟 Stream ID 是两套**。直接用 `*` 会让我们丢掉 seq 语义。

**做法**:用 `{seq}-0` 显式 ID,Redis 同 stream 内 ID 必须严格递增,等价于 MySQL `PRIMARY KEY(run_id, seq)` 的去重 + 拒乱序保护。同 runId 下并发 append 时,后到的低 seq 会被 Redis 拒(抛 `ERR The ID specified in XADD is equal or smaller`),应用层捕异常即可。

### 3.2 EXPIRE 不 DEL(八股 08 §4 热冷分层)

**场景**:Run 刚 finalize,`archiveAndCleanup` 写完冷库,如果立刻 DEL Stream,1ms 内有客户端续订 `?after_seq=N` 走的还是 Redis 路径(`streamExists` 返回 true 后才 XRANGE),会拿到空。

**做法**:`EXPIRE STREAM_KEY ttlSec`(默认 3600s)给续订一个缓冲窗口;过期后 `streamExists` 返 false,自动降级走冷库。

### 3.3 双源读取(八股 08 §1 容错降级)

```ts
// runManager.subscribe
if (await streamExists(redis, runId)) {
  events = await redisQueryEventsAfter(redis, runId, afterSeq);
} else {
  events = await queryArchivedEventsAfter(pool, runId, afterSeq);
}
```

**好处**:Redis 宕机时,Run 终态后续订仍可走冷库;Run 活跃中宕机会丢事件(本期接受,生产化阶段加哨兵 / 集群)。

### 3.4 cleanupOnStartup 兜底归档(八股 08 §5.3 优雅关闭/启动)

**场景**:进程 SIGKILL 或 archiveAndCleanup INSERT 成功但 EXPIRE 失败 → Redis 残留 stream + agent_runs 已标 failed。

**做法**:启动时 `markAllRunningAsFailed` 之后 `listOrphanRuns` SCAN `run:*:events`,对每个 runId 调 `archiveAndCleanup` 重试。`bulkInsertArchivedEvents` 用 `INSERT IGNORE` 保证幂等。

### 3.5 Pub/Sub best-effort(八股 08 §6 多副本预留)

`appendEvent` 同步 XADD + `redis.publish(...)` 不 await(catch 吞日志),本期订阅端仍走内存 Map(零延迟)。多副本部署时,后续 Task 在 RunManager 内加 `redis.subscribe(channel)` → 注入 subscribers,即可实现跨进程订阅。

---

## 4. 验证清单

1. `npm run docker:up` → mysql + redis 都健康
2. `npx tsx scripts/migrate.ts` → 006 migration 成功
3. `npm run dev` → 启动日志 `Redis connected` + `cleanupOnStartup` 报告
4. 前端发消息 → SSE token 流正常
5. `redis-cli -p 6380 XLEN run:{runId}:events` → 事件数 > 0
6. Run 完成 → `XLEN` 仍存在但 `TTL` ≈ 3600;`SELECT COUNT(*) FROM archived_run_events WHERE run_id=?` 已落库
7. 1h 后 → Redis stream 自动 EXPIRE;前端历史会话渲染正常(走冷库)
8. 流式中刷新页面 → 续订接口走 Redis XRANGE,无丢事件
9. 流式中 `kill -9 <pid>` → 重启后 `cleanupOnStartup` 把残留 stream 归档
10. 删除会话 → CASCADE 删 agent_runs → CASCADE 删 archived_run_events

---

## 5. 已知边界

- **跨进程订阅本期不接**:Pub/Sub PUBLISH 已到位,subscribe 端待补
- **归档原子性**:`XRANGE → INSERT → EXPIRE` 非事务,失败保留 Stream 由 `cleanupOnStartup` 重试,INSERT IGNORE 保证幂等
- **agent_run_events 旧表保留**:不删,旧数据可回溯;新数据不再写入
- **Redis 单点 + AOF everysec**:宕机最多丢 1s 事件;高可用留给生产化阶段

---

## 6. 关联文档

- 架构图与决策:`docs/04-架构文档/agent-架构.md` §1.1 / §1.2 / §5.10
- 八股:
  - `docs/01-面试八股文/08-工程化实践.md` §4 缓存与热层 / §1 容错降级 / §5 优雅关闭
  - `docs/01-面试八股文/05-记忆系统.md` 短期记忆事件流
- 上一阶段:`docs/03-开发笔记/note-03-整合阶段-LangGraph主线与Run-as-Resource.md`(整合-2 / agent_run_events 起点)
