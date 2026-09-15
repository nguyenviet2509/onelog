/**
 * token-cache.ts — In-memory LRU cache for per-app token verification.
 *
 * Argon2 verify costs ~50ms/call — must cache to avoid latency spike.
 * Cache key = FULL token (not just prefix) to prevent prefix-collision auth bypass.
 * TTL = 5 min — bounded staleness after revoke (worst case).
 * On revoke, invalidateByTokenId() clears matching entries immediately.
 */
import { LRUCache } from 'lru-cache';

export interface CachedToken {
  appId: string;
  tokenId: string;
  verifiedAt: number;
}

const cache = new LRUCache<string, CachedToken>({
  max: 10_000,
  ttl: 5 * 60 * 1000,
});

export function getCached(fullToken: string): CachedToken | undefined {
  return cache.get(fullToken);
}

export function setCached(fullToken: string, entry: CachedToken): void {
  cache.set(fullToken, entry);
}

/**
 * Invalidate all cache entries for a given tokenId.
 * Called from token-service.revokeAppToken() after DB soft-delete.
 * O(n) scan — acceptable because revoke is not hot path.
 */
export function invalidateByTokenId(tokenId: string): number {
  let removed = 0;
  for (const [key, val] of cache.entries()) {
    if (val.tokenId === tokenId) {
      cache.delete(key);
      removed++;
    }
  }
  return removed;
}

export function clearAll(): void {
  cache.clear();
}

export function getCacheStats(): { size: number; max: number } {
  return { size: cache.size, max: cache.max };
}
