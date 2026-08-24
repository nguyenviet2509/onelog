/**
 * webhook-pre-token.test.ts — Unit tests for POST /v1/webhooks/pre-token.
 * Mocks: Redis, Zitadel Mgmt client, DB resolve, HMAC middleware.
 * Covers: normal path, degraded path, break-glass path, admin role detection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { createHmac } from 'node:crypto';

// ── Hoist mock functions so vi.mock() factory can reference them ─────────────
// vi.mock() factories are hoisted to the top of the file by vitest; any
// variables they reference must also be hoisted via vi.hoisted().

const { mockRedisGet, mockRedisSetex } = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSetex: vi.fn().mockResolvedValue('OK'),
}));

vi.mock('../../src/lib/redis-client.js', () => ({
  redis: { get: mockRedisGet, setex: mockRedisSetex },
  checkRedisConnection: vi.fn().mockResolvedValue(true),
  getRedis: vi.fn(),
  closeRedis: vi.fn(),
}));

vi.mock('../../src/lib/zitadel-mgmt-client.js', () => ({
  listUserGrants: vi.fn(),
}));

vi.mock('../../src/db/queries/resolve.js', () => ({
  resolvePermissions: vi.fn(),
}));

vi.mock('../../src/db/queries/resolve-epoch.js', () => ({
  getResolveEpoch: vi.fn().mockResolvedValue(1),
  bumpResolveEpoch: vi.fn().mockResolvedValue(2),
  invalidateEpochCache: vi.fn(),
}));

vi.mock('../../src/db/writer-pool.js', () => ({
  writerPool: {},
  checkWriterConnection: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    NODE_ENV: 'test',
    BREAK_GLASS_USER_ID: 'bg-user-99',
    BREAK_GLASS_PERMS: 'rbac.admin.write,rbac.admin.read',
    ZITADEL_ACTION_SIGNING_KEY: 'test-signing-key-for-webhook-tests',
    ZITADEL_ORG_ID: 'org-test',
    FAIL_CLOSE_ROLE_PATTERN: '^(rbac\\..*|.*\\.admin)$',
  },
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { listUserGrants } from '../../src/lib/zitadel-mgmt-client.js';
import { resolvePermissions } from '../../src/db/queries/resolve.js';
import { webhookPreTokenRoutes } from '../../src/routes/webhook-pre-token.js';

const SIGNING_KEY = 'test-signing-key-for-webhook-tests';

/** Build a Fastify app with raw body parsing + webhook route */
async function buildTestApp() {
  const app = Fastify({ logger: false });

  // Replicate raw body capture from app.ts
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    (_req as { rawBody?: Buffer }).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  await app.register(webhookPreTokenRoutes);
  return app;
}

/** Generate a valid HMAC header for the given payload bytes */
function signPayload(body: Buffer, tsOverride?: number): string {
  const ts = tsOverride ?? Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', SIGNING_KEY);
  mac.update(`${ts}.`);
  mac.update(body);
  return `t=${ts},v1=${mac.digest('hex')}`;
}

function makePayload(userId: string, orgId = 'org-test') {
  return {
    function: 'function/preaccesstoken',
    userinfo: { sub: userId },
    user: { id: userId, username: 'testuser', resource_owner: orgId },
    org: { id: orgId, name: 'Test Org' },
    application: { client_id: 'client-abc' },
  };
}

describe('POST /v1/webhooks/pre-token', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: Redis misses, Mgmt API returns roles, DB resolves perms
    mockRedisGet.mockResolvedValue(null);
    vi.mocked(listUserGrants).mockResolvedValue([
      { grantId: 'g1', projectId: 'proj-1', orgId: 'org-test', roleKeys: ['cloud.viewer', 'dept.it'] },
    ]);
    vi.mocked(resolvePermissions).mockResolvedValue({
      permissions: ['onemcp.kb.read', 'onemcp.chat.read'],
      roles_expanded: ['cloud.viewer', 'dept.it'],
    });
    app = await buildTestApp();
  });

  // ── Auth rejection ──────────────────────────────────────────────────────────

  it('returns 401 when zitadel-signature header is missing', async () => {
    const body = JSON.stringify(makePayload('user-1'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pre-token',
      payload: body,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when signature is invalid', async () => {
    const body = JSON.stringify(makePayload('user-1'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pre-token',
      payload: body,
      headers: {
        'Content-Type': 'application/json',
        'zitadel-signature': 't=1700000000,v1=' + 'f'.repeat(64),
      },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── Normal path ─────────────────────────────────────────────────────────────

  it('returns permissions_hash + roles + ver on normal resolve', async () => {
    const payload = makePayload('user-normal');
    const bodyBytes = Buffer.from(JSON.stringify(payload));
    const sigHeader = signPayload(bodyBytes);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pre-token',
      payload: bodyBytes,
      headers: { 'Content-Type': 'application/json', 'zitadel-signature': sigHeader },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json<{ append_claims: Array<{ key: string; value: unknown }> }>();
    const claims = Object.fromEntries(json.append_claims.map((c) => [c.key, c.value]));

    expect(typeof claims['permissions_hash']).toBe('string');
    expect(claims['permissions_hash']).toHaveLength(64); // sha256 hex
    expect(Array.isArray(claims['roles'])).toBe(true);
    expect(claims['ver']).toBe(1);
  });

  it('inlines permissions[] when count <= 30', async () => {
    vi.mocked(resolvePermissions).mockResolvedValue({
      permissions: ['perm.a', 'perm.b', 'perm.c'],
      roles_expanded: ['role.x'],
    });

    const payload = makePayload('user-small-perms');
    const bodyBytes = Buffer.from(JSON.stringify(payload));
    const sigHeader = signPayload(bodyBytes);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pre-token',
      payload: bodyBytes,
      headers: { 'Content-Type': 'application/json', 'zitadel-signature': sigHeader },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json<{ append_claims: Array<{ key: string; value: unknown }> }>();
    const claims = Object.fromEntries(json.append_claims.map((c) => [c.key, c.value]));
    expect(Array.isArray(claims['permissions'])).toBe(true);
  });

  it('does NOT inline permissions[] when count > 30', async () => {
    const manyPerms = Array.from({ length: 35 }, (_, i) => `perm.item.${i}`);
    vi.mocked(resolvePermissions).mockResolvedValue({
      permissions: manyPerms,
      roles_expanded: ['role.big'],
    });

    const payload = makePayload('user-big-perms');
    const bodyBytes = Buffer.from(JSON.stringify(payload));
    const sigHeader = signPayload(bodyBytes);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pre-token',
      payload: bodyBytes,
      headers: { 'Content-Type': 'application/json', 'zitadel-signature': sigHeader },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json<{ append_claims: Array<{ key: string; value: unknown }> }>();
    const keys = json.append_claims.map((c) => c.key);
    expect(keys).not.toContain('permissions');
    expect(keys).toContain('permissions_hash');
  });

  // ── Redis cache hit ──────────────────────────────────────────────────────────

  it('uses Redis cache for user-grants and skips Mgmt API call', async () => {
    const cachedRoles = JSON.stringify(['cached.role.a']);
    // First get = user-grants hit; second get = resolve cache miss
    mockRedisGet
      .mockResolvedValueOnce(cachedRoles)  // user-grants cache hit
      .mockResolvedValueOnce(null);          // resolve cache miss

    const payload = makePayload('user-cached');
    const bodyBytes = Buffer.from(JSON.stringify(payload));
    const sigHeader = signPayload(bodyBytes);

    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pre-token',
      payload: bodyBytes,
      headers: { 'Content-Type': 'application/json', 'zitadel-signature': sigHeader },
    });

    expect(vi.mocked(listUserGrants)).not.toHaveBeenCalled();
    expect(vi.mocked(resolvePermissions)).toHaveBeenCalledWith({}, ['cached.role.a']);
  });

  // ── Degraded path ────────────────────────────────────────────────────────────

  it('returns rbac_degraded:true when resolve throws', async () => {
    vi.mocked(resolvePermissions).mockRejectedValue(new Error('DB connection lost'));

    const payload = makePayload('user-error');
    const bodyBytes = Buffer.from(JSON.stringify(payload));
    const sigHeader = signPayload(bodyBytes);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pre-token',
      payload: bodyBytes,
      headers: { 'Content-Type': 'application/json', 'zitadel-signature': sigHeader },
    });

    expect(res.statusCode).toBe(200); // always 200 for fail-open
    const json = res.json<{ append_claims: Array<{ key: string; value: unknown }> }>();
    const claims = Object.fromEntries(json.append_claims.map((c) => [c.key, c.value]));

    expect(claims['rbac_degraded']).toBe(true);
    expect(claims['permissions']).toEqual([]);
    expect(claims['ver']).toBe(1);
  });

  it('returns rbac_degraded:true when Mgmt API throws', async () => {
    vi.mocked(listUserGrants).mockRejectedValue(new Error('Zitadel Mgmt API unreachable: timeout'));

    const payload = makePayload('user-mgmt-error');
    const bodyBytes = Buffer.from(JSON.stringify(payload));
    const sigHeader = signPayload(bodyBytes);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pre-token',
      payload: bodyBytes,
      headers: { 'Content-Type': 'application/json', 'zitadel-signature': sigHeader },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json<{ append_claims: Array<{ key: string; value: unknown }> }>();
    const claims = Object.fromEntries(json.append_claims.map((c) => [c.key, c.value]));
    expect(claims['rbac_degraded']).toBe(true);
  });

  // ── Break-glass path ─────────────────────────────────────────────────────────

  it('returns explicit perms + break_glass:true for break-glass user', async () => {
    const payload = makePayload('bg-user-99'); // matches BREAK_GLASS_USER_ID in mock config
    const bodyBytes = Buffer.from(JSON.stringify(payload));
    const sigHeader = signPayload(bodyBytes);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pre-token',
      payload: bodyBytes,
      headers: { 'Content-Type': 'application/json', 'zitadel-signature': sigHeader },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json<{ append_claims: Array<{ key: string; value: unknown }> }>();
    const claims = Object.fromEntries(json.append_claims.map((c) => [c.key, c.value]));

    expect(claims['break_glass']).toBe(true);
    expect(Array.isArray(claims['permissions'])).toBe(true);
    expect((claims['permissions'] as string[]).length).toBeGreaterThan(0);
    // Must NOT be wildcard
    expect((claims['permissions'] as string[]).every((p) => !p.includes('*'))).toBe(true);
    // Must NOT call normal resolve path
    expect(vi.mocked(listUserGrants)).not.toHaveBeenCalled();
    expect(vi.mocked(resolvePermissions)).not.toHaveBeenCalled();
  });

  // ── Payload edge cases ───────────────────────────────────────────────────────

  it('returns 400 when user.id is missing from payload', async () => {
    const payload = { function: 'function/preaccesstoken', org: { id: 'org-1' } };
    const bodyBytes = Buffer.from(JSON.stringify(payload));
    const sigHeader = signPayload(bodyBytes);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pre-token',
      payload: bodyBytes,
      headers: { 'Content-Type': 'application/json', 'zitadel-signature': sigHeader },
    });

    expect(res.statusCode).toBe(400);
  });

  it('handles user with no grants (empty role set) gracefully', async () => {
    vi.mocked(listUserGrants).mockResolvedValue([]);
    vi.mocked(resolvePermissions).mockResolvedValue({ permissions: [], roles_expanded: [] });

    const payload = makePayload('user-no-grants');
    const bodyBytes = Buffer.from(JSON.stringify(payload));
    const sigHeader = signPayload(bodyBytes);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pre-token',
      payload: bodyBytes,
      headers: { 'Content-Type': 'application/json', 'zitadel-signature': sigHeader },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json<{ append_claims: Array<{ key: string; value: unknown }> }>();
    expect(json.append_claims.find((c) => c.key === 'roles')?.value).toEqual([]);
  });
});
