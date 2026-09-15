/**
 * token-cache.test.ts — Unit tests for in-memory per-app token cache.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCached,
  setCached,
  invalidateByTokenId,
  clearAll,
  getCacheStats,
} from '../../src/lib/token-cache.js';

describe('token-cache', () => {
  beforeEach(() => clearAll());

  it('returns undefined for missing key', () => {
    expect(getCached('rbac_missing_token')).toBeUndefined();
  });

  it('returns entry after setCached', () => {
    setCached('rbac_abc12345_secret', { appId: 'app-1', tokenId: 'tok-1', verifiedAt: 1 });
    expect(getCached('rbac_abc12345_secret')).toEqual({
      appId: 'app-1',
      tokenId: 'tok-1',
      verifiedAt: 1,
    });
  });

  it('invalidateByTokenId removes matching entries', () => {
    setCached('token-A', { appId: 'app-1', tokenId: 'tok-1', verifiedAt: 1 });
    setCached('token-B', { appId: 'app-1', tokenId: 'tok-1', verifiedAt: 1 });
    setCached('token-C', { appId: 'app-2', tokenId: 'tok-2', verifiedAt: 1 });

    const removed = invalidateByTokenId('tok-1');
    expect(removed).toBe(2);
    expect(getCached('token-A')).toBeUndefined();
    expect(getCached('token-B')).toBeUndefined();
    expect(getCached('token-C')).toBeDefined();
  });

  it('invalidateByTokenId returns 0 when no match', () => {
    setCached('token-X', { appId: 'a', tokenId: 'tok-x', verifiedAt: 1 });
    expect(invalidateByTokenId('unknown')).toBe(0);
  });

  it('clearAll drops all entries', () => {
    setCached('k1', { appId: 'a', tokenId: 't', verifiedAt: 1 });
    setCached('k2', { appId: 'a', tokenId: 't', verifiedAt: 1 });
    clearAll();
    expect(getCacheStats().size).toBe(0);
  });

  it('reports cache stats', () => {
    setCached('k1', { appId: 'a', tokenId: 't', verifiedAt: 1 });
    const stats = getCacheStats();
    expect(stats.size).toBe(1);
    expect(stats.max).toBe(10_000);
  });
});
