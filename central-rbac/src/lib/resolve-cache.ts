/**
 * lib/resolve-cache.ts — Redis cache helpers cho /v2/resolve + /v2/epoch.
 * Phase 09 (plan 260910-1334).
 *
 * Cache keys:
 *   resolve:v2:{app_slug}:{user_sub}:{tenant_id}:e{epoch}  TTL 60s
 *   epoch:{app_slug}                                        TTL 5s
 *
 * Epoch trong resolve key = per-app epoch. Grant mutation → trigger bump epoch →
 * new key namespace → cache implicit-invalidated (old key vẫn TTL expire).
 *
 * Fail-open behavior: Redis error → return null (caller falls through to DB).
 */
import { redis } from './redis-client.js';
import { logger } from './logger.js';
import type { ResolveV2Result } from '../db/queries/resolve-v2.js';

const RESOLVE_V2_TTL_S = 60;
const EPOCH_TTL_S = 5;

function resolveKey(appSlug: string, userSub: string, tenantId: string | null, epoch: number): string {
  return `resolve:v2:${appSlug}:${userSub}:${tenantId ?? 'NULL'}:e${epoch}`;
}

function epochKey(appSlug: string): string {
  return `epoch:${appSlug}`;
}

// ── Resolve cache ────────────────────────────────────────────────────────────

export async function getCachedResolveV2(
  appSlug: string,
  userSub: string,
  tenantId: string | null,
  epoch: number,
): Promise<ResolveV2Result | null> {
  try {
    const cached = await redis.get(resolveKey(appSlug, userSub, tenantId, epoch));
    if (cached) {
      return JSON.parse(cached) as ResolveV2Result;
    }
  } catch (err) {
    logger.warn({ err, appSlug, userSub }, 'resolve-cache: get failed — fallback DB');
  }
  return null;
}

export async function setCachedResolveV2(
  appSlug: string,
  userSub: string,
  tenantId: string | null,
  result: ResolveV2Result,
): Promise<void> {
  try {
    await redis.setex(
      resolveKey(appSlug, userSub, tenantId, result.epoch),
      RESOLVE_V2_TTL_S,
      JSON.stringify(result),
    );
  } catch (err) {
    logger.warn({ err, appSlug, userSub }, 'resolve-cache: setex failed — result not cached');
  }
}

// ── Epoch cache ──────────────────────────────────────────────────────────────

export async function getCachedEpoch(appSlug: string): Promise<number | null> {
  try {
    const cached = await redis.get(epochKey(appSlug));
    if (cached) {
      const parsed = parseInt(cached, 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
  } catch (err) {
    logger.warn({ err, appSlug }, 'resolve-cache: epoch get failed — fallback DB');
  }
  return null;
}

export async function setCachedEpoch(appSlug: string, epoch: number): Promise<void> {
  try {
    await redis.setex(epochKey(appSlug), EPOCH_TTL_S, epoch.toString());
  } catch (err) {
    logger.warn({ err, appSlug }, 'resolve-cache: epoch setex failed');
  }
}
