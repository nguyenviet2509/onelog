/**
 * rate-limit-admin.ts — Rate limit for admin write endpoints (Phase 07 Fix #11).
 *
 * Enforces sliding 24h windows on ALL attempts that reach Zitadel (any 2xx or 4xx
 * response counted — NOT only success). This prevents the attack:
 *   attacker forces validation errors to warm counter, then bursts successes at reset.
 *
 * Two-tier limit:
 *   - Per-admin: default 5/24h (env RATE_LIMIT_ADMIN_APP_CREATE_PER_ADMIN)
 *   - Global:    default 20/24h across all admins (env RATE_LIMIT_ADMIN_APP_CREATE_GLOBAL)
 *
 * Preview endpoint separately rate-limited via previewLimit (10/hour) at route level.
 *
 * Storage: Redis sorted sets (ZADD ts, ZREMRANGEBYSCORE < now-24h, ZCARD).
 * Sliding window is inherently correct — not calendar-day-reset.
 */
import type { FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import { redis } from '../lib/redis-client.js';
import { logger } from '../lib/logger.js';

const WINDOW_SEC = 24 * 60 * 60;
const DEFAULT_PER_ADMIN = 5;
const DEFAULT_GLOBAL = 20;

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const parsed = parseInt(v, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Sliding-window counter — returns count of events within last WINDOW_SEC seconds.
 * Increments counter BEFORE returning count (fail-closed vs bypass via double-check-lock races).
 */
async function incrementAndCount(key: string): Promise<number> {
  const now = Date.now();
  const cutoff = now - WINDOW_SEC * 1000;
  const pipeline = redis.multi();
  pipeline.zremrangebyscore(key, 0, cutoff);
  // Score = timestamp; member = timestamp string (unique-ish, small collision risk fine for rate-limit).
  pipeline.zadd(key, now, `${now}-${Math.random().toString(36).slice(2, 8)}`);
  pipeline.zcard(key);
  pipeline.expire(key, WINDOW_SEC + 60);
  const results = await pipeline.exec();
  if (!results) return 0;
  // zcard is at index 2
  const zcardResult = results[2];
  if (!zcardResult || zcardResult[0]) return 0; // error path
  return Number(zcardResult[1] ?? 0);
}

export interface RateLimitOptions {
  perAdminLimit?: number;
  globalLimit?: number;
  scope: string;   // e.g., 'admin_app_create' — Redis key prefix
}

/**
 * Build a preHandler that enforces per-admin + global rate limits.
 * Requires request.jwtClaims to be set (chain AFTER verifyJwt).
 *
 * On limit hit: returns 429 with retry-after seconds.
 * Increments counter BEFORE hitting Zitadel (Fix #11: count attempts, not successes).
 */
export function rateLimitAdmin(opts: RateLimitOptions): preHandlerAsyncHookHandler {
  const perAdmin = opts.perAdminLimit ?? envInt('RATE_LIMIT_ADMIN_APP_CREATE_PER_ADMIN', DEFAULT_PER_ADMIN);
  const global = opts.globalLimit ?? envInt('RATE_LIMIT_ADMIN_APP_CREATE_GLOBAL', DEFAULT_GLOBAL);

  return async function rateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sub = request.jwtClaims?.sub;
    if (!sub) {
      // Upstream verifyJwt should reject — belt-and-braces
      logger.warn('rate-limit-admin: no JWT sub — verifyJwt not chained?');
      return reply.status(401).send({ error: 'Missing subject' });
    }

    const perAdminKey = `ratelimit:${opts.scope}:admin:${sub}`;
    const globalKey = `ratelimit:${opts.scope}:global`;

    const [perAdminCount, globalCount] = await Promise.all([
      incrementAndCount(perAdminKey),
      incrementAndCount(globalKey),
    ]);

    if (perAdminCount > perAdmin) {
      logger.warn(
        { sub, count: perAdminCount, limit: perAdmin, scope: opts.scope },
        'rate-limit-admin: per-admin quota exceeded',
      );
      return reply
        .status(429)
        .header('Retry-After', String(WINDOW_SEC))
        .send({ error: 'Per-admin rate limit exceeded', limit: perAdmin, window_sec: WINDOW_SEC });
    }

    if (globalCount > global) {
      logger.warn(
        { count: globalCount, limit: global, scope: opts.scope },
        'rate-limit-admin: global quota exceeded',
      );
      return reply
        .status(429)
        .header('Retry-After', String(WINDOW_SEC))
        .send({ error: 'Global rate limit exceeded', limit: global, window_sec: WINDOW_SEC });
    }
  };
}
