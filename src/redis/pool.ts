/**
 * Task 5.4 — Redis 连接池(单例)
 *
 * 规划:docs/开发规划.md Task 5.4(Redis Pub/Sub 跨进程预留)
 * 八股:docs/01-面试八股文/08-工程化实践.md §1 容错 / §4 缓存与热层
 *
 * 设计要点:
 * - ioredis 自带连接池 + 重连 + 命令重试,无需自己管
 * - 单例:模块级变量,避免重复创建连接
 * - 优雅关闭:进程退出前调用 quit()(等待未完成命令 vs disconnect 立即断开)
 * - lazyConnect=false:启动时立即连接,fail-fast 暴露配置错误
 */

import { Redis } from 'ioredis'

let _redis: Redis | null = null

export function createRedis(url: string): Redis {
    if (_redis) return _redis
    const client = new Redis(url, {
        // 命令级重试:断线时自动重连并 replay 未完成命令(默认行为,显式声明)
        maxRetriesPerRequest: 3,
        enableOfflineQueue: true,
        // 启动时立即建连,失败立刻抛错(避免延迟到第一次命令时才发现)
        lazyConnect: false
    })
    _redis = client
    return client
}

export type RedisClient = Redis

/**
 * 优雅关闭:等待 in-flight 命令完成后再断开
 * SIGTERM/SIGINT 钩子调用
 */
export async function closeRedis(): Promise<void> {
    if (!_redis) return
    try {
        await _redis.quit()
    } catch {
        // 已经断开就忽略
        _redis.disconnect()
    }
    _redis = null
}
