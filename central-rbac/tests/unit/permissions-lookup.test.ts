/**
 * permissions-lookup.test.ts — Unit tests for GET /v1/permissions-lookup.
 * Verifies: cache hit, cache miss (404), corrupt cache eviction, Redis error (503).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: { NODE_ENV: 'test', CENTRAL_RBAC_CORS_ORIGIN: '' },
}));

const { mockRedisGet, mockRedisSetex, mockRedisDel } = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSetex: vi.fn().mockResolvedValue('OK'),
  mockRedisDel: vi.fn().mockResolvedValue(1),
}));

vi.mock('../../src/lib/redis-client.js', () => ({
  redis: {
    get: mockRedisGet,
    setex: mockRedisSetex,
    del: mockRedisDel,
  },
  checkRedisConnection: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/middleware/auth-jwt.js', () => ({
  verifyJwt: vi.fn((_req: unknown, _reply: unknown, done: () => void) => done()),
}));

import { permissionsLookupRoutes, permHashKey } from '../../src/routes/permissions-lookup.js';

const VALID_HASH = 'a'.repeat(64); // 64-char hex

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(permissionsLookupRoutes);
  return app;
}

describe('GET /v1/permissions-lookup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns permissions array on cache hit', async () => {
    const perms = ['onemcp.kb.read', 'onemcp.kb.write'];
    mockRedisGet.mockResolvedValue(JSON.stringify(perms));

    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/permissions-lookup?hash=${VALID_HASH}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { hash: string; permissions: string[] };
    expect(body.hash).toBe(VALID_HASH);
    expect(body.permissions).toEqual(perms);
  });

  it('uses correct Redis key format (perm-hash:{hash})', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify(['perm.a']));

    const app = await buildTestApp();
    await app.inject({ method: 'GET', url: `/v1/permissions-lookup?hash=${VALID_HASH}` });

    expect(mockRedisGet).toHaveBeenCalledWith(permHashKey(VALID_HASH));
    expect(mockRedisGet).toHaveBeenCalledWith(`perm-hash:${VALID_HASH}`);
  });

  it('returns 404 when hash not in cache', async () => {
    mockRedisGet.mockResolvedValue(null);

    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/permissions-lookup?hash=${VALID_HASH}`,
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string; hint: string };
    expect(body.error).toMatch(/not found/i);
    expect(body.hint).toMatch(/5min/i);
  });

  it('returns 503 when Redis get throws', async () => {
    mockRedisGet.mockRejectedValue(new Error('Redis connection refused'));

    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/permissions-lookup?hash=${VALID_HASH}`,
    });

    expect(res.statusCode).toBe(503);
  });

  it('evicts corrupt cache entry and returns 500', async () => {
    mockRedisGet.mockResolvedValue('not-valid-json{{{{');

    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/permissions-lookup?hash=${VALID_HASH}`,
    });

    expect(res.statusCode).toBe(500);
    expect(mockRedisDel).toHaveBeenCalledWith(permHashKey(VALID_HASH));
  });

  it('rejects hash that is not 64 hex chars', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/permissions-lookup?hash=tooshort',
    });

    expect(res.statusCode).toBe(400);
    expect(mockRedisGet).not.toHaveBeenCalled();
  });

  it('rejects non-hex characters in hash', async () => {
    const badHash = 'g'.repeat(64); // 'g' is not hex
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/permissions-lookup?hash=${badHash}`,
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when hash query param is missing', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/permissions-lookup' });
    expect(res.statusCode).toBe(400);
  });
});

describe('permHashKey', () => {
  it('produces perm-hash: prefixed key', () => {
    expect(permHashKey('abc123')).toBe('perm-hash:abc123');
  });
});
