/**
 * verify-per-app-token.test.ts — Unit tests for per-app token verification.
 * Mocks DB (writer-pool) and argon2.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();

vi.mock('../../src/db/writer-pool.js', () => ({
  writerPool: { query: (...args: unknown[]) => queryMock(...args) },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const argon2VerifyMock = vi.fn();
vi.mock('argon2', () => ({
  default: { verify: (...args: unknown[]) => argon2VerifyMock(...args) },
}));

import { verifyPerAppToken, PER_APP_TOKEN_RE } from '../../src/lib/verify-per-app-token.js';
import { clearAll } from '../../src/lib/token-cache.js';

const VALID_TOKEN = 'rbac_abc12345_kqr7x8v9w2n5c4b1d6h3p0aa';

describe('verify-per-app-token', () => {
  beforeEach(() => {
    queryMock.mockReset();
    // Default: return empty result so fire-and-forget UPDATE last_used_at doesn't crash.
    queryMock.mockResolvedValue({ rowCount: 0, rows: [] });
    argon2VerifyMock.mockReset();
    clearAll();
  });

  describe('PER_APP_TOKEN_RE', () => {
    it('accepts valid format', () => {
      expect(PER_APP_TOKEN_RE.test(VALID_TOKEN)).toBe(true);
    });
    it('rejects wrong prefix', () => {
      expect(PER_APP_TOKEN_RE.test('other_abc12345_kqr7x8v9w2n5c4b1d6h3p0aa')).toBe(false);
    });
    it('rejects short secret', () => {
      expect(PER_APP_TOKEN_RE.test('rbac_abc12345_short')).toBe(false);
    });
    it('rejects uppercase', () => {
      expect(PER_APP_TOKEN_RE.test('rbac_ABC12345_kqr7x8v9w2n5c4b1d6h3p0aa')).toBe(false);
    });
  });

  it('returns null for malformed token', async () => {
    const result = await verifyPerAppToken('not-a-token');
    expect(result).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns null when prefix not found', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const result = await verifyPerAppToken(VALID_TOKEN);
    expect(result).toBeNull();
    expect(argon2VerifyMock).not.toHaveBeenCalled();
  });

  it('returns null when argon2 hash mismatch', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'tok-1', app_id: 'app-1', token_hash: '$argon2id$...' }],
    });
    argon2VerifyMock.mockResolvedValueOnce(false);
    const result = await verifyPerAppToken(VALID_TOKEN);
    expect(result).toBeNull();
  });

  it('returns {appId, tokenId} on successful verify', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'tok-1', app_id: 'app-1', token_hash: '$argon2id$...' }],
    });
    argon2VerifyMock.mockResolvedValueOnce(true);
    const result = await verifyPerAppToken(VALID_TOKEN);
    expect(result).toEqual({ appId: 'app-1', tokenId: 'tok-1' });
  });

  it('caches successful verify (2nd call skips DB + argon2)', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'tok-1', app_id: 'app-1', token_hash: '$argon2id$...' }],
    });
    argon2VerifyMock.mockResolvedValueOnce(true);

    await verifyPerAppToken(VALID_TOKEN);
    // 2nd call: should not touch queryMock again (cache hit) — but throttled UPDATE last_used may fire.
    const secondCall = await verifyPerAppToken(VALID_TOKEN);
    expect(secondCall).toEqual({ appId: 'app-1', tokenId: 'tok-1' });
    // argon2.verify called exactly once (first call only)
    expect(argon2VerifyMock).toHaveBeenCalledTimes(1);
  });

  it('returns null if argon2.verify throws', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'tok-1', app_id: 'app-1', token_hash: 'malformed' }],
    });
    argon2VerifyMock.mockRejectedValueOnce(new Error('bad hash format'));
    const result = await verifyPerAppToken(VALID_TOKEN);
    expect(result).toBeNull();
  });
});
