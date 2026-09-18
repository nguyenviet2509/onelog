/**
 * rate-limit-create.ts — Per-sub rate limit for POST /v1/roles + /v1/permissions.
 *
 * Prevents member spam: 10 creates/60s per JWT sub. Admin bypass (unlimited).
 * Redis sorted-set sliding window — same pattern as rate-limit-admin, shorter window.
 *
 * Plan: 260918-1308-central-rbac-authz-full-cleanup Phase 04 (Y6).
 */
import type { FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import { redis } from '../lib/redis-client.js';
import { logger } from '../lib/logger.js';
import { isAdmin } from './require-admin-or-owner.js';

const WINDOW_SEC = 60;
const DEFAULT_LIMIT = 10;

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const parsed = parseInt(v, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

async function incrementAndCount(key: string): Promise<number> {
  const now = Date.now();
  const cutoff = now - WINDOW_SEC * 1000;
  const pipeline = redis.multi();
  pipeline.zremrangebyscore(key, 0, cutoff);
  pipeline.zadd(key, now, `${now}-${Math.random().toString(36).slice(2, 8)}`);
  pipeline.zcard(key);
  pipeline.expire(key, WINDOW_SEC + 10);
  const results = await pipeline.exec();
  if (!results) return 0;
  const zcardResult = results[2];
  if (!zcardResult || zcardResult[0]) return 0;
  return Number(zcardResult[1] ?? 0);
}

/**
 * Build preHandler that limits POST creates per JWT sub.
 * @param scope Redis key prefix (e.g. 'role_create', 'perm_create')
 */
export function rateLimitCreate(scope: string): preHandlerAsyncHookHandler {
  const limit = envInt('RATE_LIMIT_CREATE_PER_MIN', DEFAULT_LIMIT);
  return async function limitCreate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Admin bypass — unlimited for bulk imports/manifest sync
    if (isAdmin(request)) return;

    const sub = request.jwtClaims?.sub;
    if (!sub) {
      return reply.status(401).send({ error: 'Missing subject' });
    }

    const key = `ratelimit:${scope}:${sub}`;
    const count = await incrementAndCount(key);
    if (count > limit) {
      logger.warn({ sub, count, limit, scope }, 'rate-limit-create: quota exceeded');
      return reply
        .status(429)
        .header('Retry-After', String(WINDOW_SEC))
        .send({ error: 'Rate limit exceeded', limit, window_sec: WINDOW_SEC });
    }
  };
}
