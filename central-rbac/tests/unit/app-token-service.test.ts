/**
 * app-token-service.test.ts — Unit tests for token generation.
 * Full CRUD integration test lives in tests/integration/.
 */
import { describe, it, expect, vi } from 'vitest';
import argon2 from 'argon2';

// Mock DB pool + logger so config validation doesn't run in test env.
vi.mock('../../src/db/writer-pool.js', () => ({
  writerPool: { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { generateToken } = await import('../../src/services/app-token-service.js');
const { PER_APP_TOKEN_RE } = await import('../../src/lib/verify-per-app-token.js');

describe('generateToken', () => {
  it('produces token matching PER_APP_TOKEN_RE', () => {
    for (let i = 0; i < 50; i++) {
      const { fullToken } = generateToken();
      expect(fullToken).toMatch(PER_APP_TOKEN_RE);
    }
  });

  it('extracts prefix consistent with full token', () => {
    for (let i = 0; i < 50; i++) {
      const { fullToken, prefix } = generateToken();
      expect(prefix).toHaveLength(8);
      expect(fullToken.startsWith(`rbac_${prefix}_`)).toBe(true);
    }
  });

  it('generates unique tokens (collision-free over 1000 samples)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const { fullToken } = generateToken();
      expect(seen.has(fullToken)).toBe(false);
      seen.add(fullToken);
    }
  });

  it('generates unique prefixes with high probability', () => {
    // 32^8 = 1T combos → expect 0 collisions over 1000 samples
    const seen = new Set<string>();
    let collisions = 0;
    for (let i = 0; i < 1000; i++) {
      const { prefix } = generateToken();
      if (seen.has(prefix)) collisions++;
      seen.add(prefix);
    }
    expect(collisions).toBe(0);
  });
});

describe('argon2 roundtrip', () => {
  it('argon2id.hash → argon2.verify passes for generated token', async () => {
    const { fullToken } = generateToken();
    const hash = await argon2.hash(fullToken, { type: argon2.argon2id });
    expect(await argon2.verify(hash, fullToken)).toBe(true);
  });

  it('argon2.verify fails for wrong token', async () => {
    const { fullToken: t1 } = generateToken();
    const { fullToken: t2 } = generateToken();
    const hash = await argon2.hash(t1, { type: argon2.argon2id });
    expect(await argon2.verify(hash, t2)).toBe(false);
  });
});
