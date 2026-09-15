/**
 * verify-per-app-token.ts — Per-app token verify logic for /v2/resolve auth.
 *
 * Format: rbac_<8char-base32-prefix>_<24char-base32-secret>
 *
 * Flow:
 *   1. Regex validate format
 *   2. Check in-memory cache → return early if hit
 *   3. DB lookup by prefix (indexed WHERE revoked_at IS NULL)
 *   4. argon2.verify(full_token, stored_hash)
 *   5. Cache result for 5 min
 *   6. Throttled UPDATE last_used_at (60s bucket per token)
 */
import argon2 from 'argon2';
import { writerPool } from '../db/writer-pool.js';
import { logger } from './logger.js';
import { getCached, setCached, type CachedToken } from './token-cache.js';

export const PER_APP_TOKEN_RE = /^rbac_([a-z0-9]{8})_[a-z0-9]{24}$/;

export interface VerifiedToken {
  appId: string;
  tokenId: string;
}

// Throttle last_used_at updates: max 1 per token per 60s.
const lastUsedThrottle = new Map<string, number>();
const LAST_USED_THROTTLE_MS = 60 * 1000;
const LAST_USED_MAP_MAX = 10_000;

function scheduleLastUsedUpdate(tokenId: string): void {
  const now = Date.now();
  const last = lastUsedThrottle.get(tokenId) ?? 0;
  if (now - last < LAST_USED_THROTTLE_MS) return;
  lastUsedThrottle.set(tokenId, now);
  // Best-effort GC: if map grows too large, drop oldest half.
  if (lastUsedThrottle.size > LAST_USED_MAP_MAX) {
    const entries = Array.from(lastUsedThrottle.entries()).sort((a, b) => a[1] - b[1]);
    for (const [k] of entries.slice(0, Math.floor(LAST_USED_MAP_MAX / 2))) {
      lastUsedThrottle.delete(k);
    }
  }
  writerPool
    .query(`UPDATE rbac.app_tokens SET last_used_at = now() WHERE id = $1`, [tokenId])
    .catch((err: unknown) => logger.warn({ err, tokenId }, 'app_token last_used_at update failed'));
}

/**
 * Verify a per-app token. Returns null if:
 *   - Format doesn't match rbac_<prefix>_<secret>
 *   - Prefix not found (no active token with this prefix)
 *   - argon2 verify fails (hash mismatch)
 *
 * Returns {appId, tokenId} on success. Caches successful verify for 5 min.
 */
export async function verifyPerAppToken(fullToken: string): Promise<VerifiedToken | null> {
  // Cache hit — return early
  const cached = getCached(fullToken);
  if (cached) {
    scheduleLastUsedUpdate(cached.tokenId);
    return { appId: cached.appId, tokenId: cached.tokenId };
  }

  const match = PER_APP_TOKEN_RE.exec(fullToken);
  if (!match) return null;
  const prefix = match[1];

  const { rows, rowCount } = await writerPool.query<{ id: string; app_id: string; token_hash: string }>(
    `SELECT id, app_id, token_hash
     FROM rbac.app_tokens
     WHERE token_prefix = $1 AND revoked_at IS NULL
     LIMIT 1`,
    [prefix],
  );

  if (!rowCount || rows.length === 0) return null;

  const row = rows[0]!;
  let ok = false;
  try {
    ok = await argon2.verify(row.token_hash, fullToken);
  } catch (err) {
    logger.warn({ err, prefix }, 'argon2.verify threw — treating as auth failure');
    return null;
  }
  if (!ok) return null;

  const entry: CachedToken = {
    appId: row.app_id,
    tokenId: row.id,
    verifiedAt: Date.now(),
  };
  setCached(fullToken, entry);
  scheduleLastUsedUpdate(row.id);
  return { appId: row.app_id, tokenId: row.id };
}
