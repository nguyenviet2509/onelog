/**
 * redis-client.ts — ioredis singleton for central-rbac.
 * LFU eviction policy enforced server-side; client-side retry strategy
 * backs off exponentially up to 10s, max 10 attempts before giving up.
 *
 * Usage: import { redis } from './redis-client.js'
 * Use: import { checkRedisConnection } from './redis-client.js' for health checks.
 */
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from './logger.js';

let redisInstance: Redis | null = null;
let connectionOk = false;

function createRedisClient(): Redis {
  const client = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD || undefined,
    lazyConnect: true, // connect on first use, not at import time
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false, // fail fast when disconnected — caller handles degraded
    connectTimeout: 3000,
    commandTimeout: 1000,
    retryStrategy(times: number): number | null {
      if (times >= 10) {
        logger.error({ attempts: times }, 'redis-client: max reconnect attempts reached — giving up');
        return null; // stop retrying
      }
      const delay = Math.min(times * 200, 10_000);
      logger.warn({ attempt: times, delayMs: delay }, 'redis-client: reconnect attempt');
      return delay;
    },
  });

  client.on('connect', () => {
    connectionOk = true;
    logger.info('redis-client: connected');
  });

  client.on('ready', () => {
    connectionOk = true;
    logger.info('redis-client: ready');
  });

  client.on('error', (err: Error) => {
    connectionOk = false;
    // Do not re-throw — log and let caller handle gracefully
    logger.error({ err: err.message }, 'redis-client: error');
  });

  client.on('close', () => {
    connectionOk = false;
    logger.warn('redis-client: connection closed');
  });

  return client;
}

/**
 * Lazy singleton — created once, reused across requests.
 * Safe to call at module load time.
 */
export function getRedis(): Redis {
  if (!redisInstance) {
    redisInstance = createRedisClient();
    // Initiate connection in background; errors handled via event listener above
    redisInstance.connect().catch((err: unknown) => {
      logger.error({ err }, 'redis-client: initial connect failed');
    });
  }
  return redisInstance;
}

export const redis = getRedis();

/**
 * Health check — returns true if Redis is reachable and responsive.
 * Used by /v1/health route.
 */
export async function checkRedisConnection(): Promise<boolean> {
  if (!redisInstance || !connectionOk) return false;
  try {
    const result = await redisInstance.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown — close Redis connection cleanly on process exit.
 * Called from app shutdown hooks.
 */
export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
    connectionOk = false;
  }
}
