/**
 * resolve-epoch.ts — Epoch counter for cache invalidation.
 * Stored in rbac.metadata table as key='resolve_epoch'.
 * Bumped on every role_permissions INSERT/UPDATE/DELETE.
 *
 * Cache key format: resolve:v{epoch}:{sha256(sorted_roles)}
 * Old cache entries age out via TTL (900s) — no SCAN/DEL needed.
 */
import type { Pool, PoolClient } from 'pg';
import { logger } from '../../lib/logger.js';

// In-process epoch cache: avoids a DB round-trip on every cache hit path.
// Invalidated when a mutation triggers bumpEpoch().
let _cachedEpoch: number | null = null;

/**
 * Get current resolve epoch.
 * Uses in-process cache; falls back to DB read on cache miss.
 * Returns 0 on DB error (cache key includes 0 — safe fallback).
 */
export async function getResolveEpoch(pool: Pool): Promise<number> {
  if (_cachedEpoch !== null) return _cachedEpoch;

  try {
    const res = await pool.query<{ value: string }>(
      `SELECT value FROM rbac.metadata WHERE key = 'resolve_epoch' LIMIT 1`,
    );
    const epoch = res.rows[0] ? parseInt(res.rows[0].value, 10) : 0;
    _cachedEpoch = Number.isNaN(epoch) ? 0 : epoch;
    return _cachedEpoch;
  } catch (err) {
    logger.error({ err }, 'resolve-epoch: getResolveEpoch DB error — defaulting to 0');
    return 0;
  }
}

/**
 * Bump epoch by 1 atomically.
 * Upserts rbac.metadata(key='resolve_epoch').
 * Invalidates in-process cache so next getResolveEpoch reads fresh value.
 *
 * Accepts optional PoolClient for transaction participation.
 */
export async function bumpResolveEpoch(poolOrClient: Pool | PoolClient): Promise<number> {
  const res = await poolOrClient.query<{ value: string }>(
    `INSERT INTO rbac.metadata (key, value)
       VALUES ('resolve_epoch', '1')
     ON CONFLICT (key) DO UPDATE
       SET value = (rbac.metadata.value::bigint + 1)::text,
           updated_at = now()
     RETURNING value`,
  );
  const newEpoch = parseInt(res.rows[0]?.value ?? '0', 10);
  _cachedEpoch = newEpoch; // update in-process cache
  logger.info({ epoch: newEpoch }, 'resolve-epoch: bumped');
  return newEpoch;
}

/** Invalidate in-process cache (called after bumpResolveEpoch externally). */
export function invalidateEpochCache(): void {
  _cachedEpoch = null;
}
