/**
 * drift.test.ts — Unit tests for GET /v1/drift endpoint.
 * Verifies mismatch detection logic for central_only and zitadel_only cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    ZITADEL_PROJECT_ID: 'proj-test',
    ZITADEL_ORG_ID: 'org-test',
    NODE_ENV: 'test',
    CENTRAL_RBAC_CORS_ORIGIN: '',
  },
}));

vi.mock('../../src/db/writer-pool.js', () => ({
  writerPool: {},
  checkWriterConnection: vi.fn().mockResolvedValue(true),
}));

const { mockListRoles, mockListProjectRoles } = vi.hoisted(() => ({
  mockListRoles: vi.fn(),
  mockListProjectRoles: vi.fn(),
}));

vi.mock('../../src/db/queries/roles.js', () => ({ listRoles: mockListRoles }));
vi.mock('../../src/lib/zitadel-mgmt-client.js', () => ({ listProjectRoles: mockListProjectRoles }));

// JWT middleware: allow all in test
vi.mock('../../src/middleware/auth-jwt.js', () => ({
  verifyJwt: vi.fn((_req: unknown, _reply: unknown, done: () => void) => done()),
}));

import { driftRoutes } from '../../src/routes/drift.js';

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(driftRoutes);
  return app;
}

describe('GET /v1/drift', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ok=true with zero mismatches when central and Zitadel match', async () => {
    mockListRoles.mockResolvedValue([
      { key: 'role.a' }, { key: 'role.b' },
    ]);
    mockListProjectRoles.mockResolvedValue([
      { roleKey: 'role.a', displayName: 'Role A', group: '' },
      { roleKey: 'role.b', displayName: 'Role B', group: '' },
    ]);

    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/drift' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; mismatches: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.mismatches).toHaveLength(0);
  });

  it('reports central_only mismatch when role missing from Zitadel', async () => {
    mockListRoles.mockResolvedValue([{ key: 'role.a' }, { key: 'role.missing' }]);
    mockListProjectRoles.mockResolvedValue([
      { roleKey: 'role.a', displayName: 'Role A', group: '' },
    ]);

    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/drift' });

    const body = JSON.parse(res.body) as { ok: boolean; mismatches: Array<{ type: string; role_key: string }> };
    expect(body.ok).toBe(false);
    expect(body.mismatches).toHaveLength(1);
    expect(body.mismatches[0]!.type).toBe('central_only');
    expect(body.mismatches[0]!.role_key).toBe('role.missing');
  });

  it('reports zitadel_only mismatch when role missing from Central', async () => {
    mockListRoles.mockResolvedValue([{ key: 'role.a' }]);
    mockListProjectRoles.mockResolvedValue([
      { roleKey: 'role.a', displayName: 'Role A', group: '' },
      { roleKey: 'role.ghost', displayName: 'Ghost', group: '' },
    ]);

    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/drift' });

    const body = JSON.parse(res.body) as { ok: boolean; mismatches: Array<{ type: string; role_key: string }> };
    expect(body.ok).toBe(false);
    expect(body.mismatches[0]!.type).toBe('zitadel_only');
    expect(body.mismatches[0]!.role_key).toBe('role.ghost');
  });

  it('reports both types when multiple mismatches', async () => {
    mockListRoles.mockResolvedValue([{ key: 'only-central' }]);
    mockListProjectRoles.mockResolvedValue([
      { roleKey: 'only-zitadel', displayName: 'Z', group: '' },
    ]);

    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/drift' });

    const body = JSON.parse(res.body) as { ok: boolean; mismatches: Array<{ type: string }> };
    expect(body.ok).toBe(false);
    expect(body.mismatches).toHaveLength(2);
    const types = body.mismatches.map((m) => m.type);
    expect(types).toContain('central_only');
    expect(types).toContain('zitadel_only');
  });

  it('returns 502 when Zitadel is unreachable', async () => {
    mockListRoles.mockResolvedValue([{ key: 'role.a' }]);
    mockListProjectRoles.mockRejectedValue(new Error('Zitadel Mgmt API unreachable: ECONNREFUSED'));

    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/drift' });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/Zitadel/);
  });

  it('includes counts in response', async () => {
    mockListRoles.mockResolvedValue([{ key: 'role.a' }, { key: 'role.b' }]);
    mockListProjectRoles.mockResolvedValue([
      { roleKey: 'role.a', displayName: 'A', group: '' },
      { roleKey: 'role.b', displayName: 'B', group: '' },
    ]);

    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/drift' });

    const body = JSON.parse(res.body) as { central_role_count: number; zitadel_role_count: number };
    expect(body.central_role_count).toBe(2);
    expect(body.zitadel_role_count).toBe(2);
  });
});
