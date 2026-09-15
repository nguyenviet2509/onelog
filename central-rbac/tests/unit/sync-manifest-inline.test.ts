/**
 * sync-manifest-inline.test.ts — Plan 260915-1615 phase 3.
 *
 * Verifies the inline import endpoint parses JSON+YAML correctly and delegates
 * to shared validate+diff pipeline. validateManifest/computeDiff logic is covered
 * in their own tests — this suite focuses on the inline endpoint wiring:
 *
 *   - YAML parse OK → canonical JSON → passes to validator
 *   - JSON parse OK → same code path
 *   - YAML syntax error → 400 with clear detail
 *   - Content > 100KB → 400 (zod max)
 *   - Manifest validation failure → 400 propagates errors
 *   - v2 manifest (with parent_key/can_grant) → 200 with schema='2' in response
 *   - Same sha256 for equivalent yaml + json payloads (canonical hashing)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const { mockRedisGet, mockRedisSetex, mockWriterQuery } = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSetex: vi.fn().mockResolvedValue('OK'),
  mockWriterQuery: vi.fn(),
}));

vi.mock('../../src/lib/redis-client.js', () => ({
  redis: { get: mockRedisGet, setex: mockRedisSetex, del: vi.fn() },
}));

vi.mock('../../src/db/writer-pool.js', () => ({
  writerPool: {
    query: mockWriterQuery,
    connect: vi.fn(async () => ({
      query: mockWriterQuery,
      release: vi.fn(),
    })),
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: { ZITADEL_ORG_ID: 'org-test', ZITADEL_PROJECT_ID: 'proj-test' },
}));

// Bypass JWT — inject sub directly so audit + inline endpoint work.
vi.mock('../../src/middleware/auth-jwt.js', () => ({
  verifyJwt: async (req: { jwtClaims?: unknown }) => {
    req.jwtClaims = { sub: 'test-admin', email: 'admin@test' };
  },
}));

vi.mock('../../src/middleware/audit-log.js', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/manifest-fetcher.js', () => ({
  fetchManifest: vi.fn(),
  validateSafeUrl: vi.fn(async () => undefined),
}));

vi.mock('../../src/db/queries/outbox.js', () => ({
  enqueueOutbox: vi.fn().mockResolvedValue({ id: 'ob-1', idempotency_key: 'k', inserted: true }),
}));

import { adminAppsSyncManifestRoutes } from '../../src/routes/admin-apps-sync-manifest.js';

const APP_ID = '00000000-0000-0000-0000-000000000abc';
const APP_SLUG = 'onelog-agent';

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(adminAppsSyncManifestRoutes);
  return app;
}

/** Configure DB response chain: loadApp → autoWireDefaultRoles queries. */
function stubDbFor(schemaVersion: '1' | '2'): void {
  mockWriterQuery.mockImplementation(async (sql: string) => {
    // loadApp
    if (sql.includes('SELECT id, slug, name, manifest_url')) {
      return {
        rows: [
          {
            id: APP_ID,
            slug: APP_SLUG,
            name: 'OneLog Agent',
            manifest_url: null,
            manifest_etag: null,
          },
        ],
      };
    }
    // computeDiff: SELECT permissions
    if (sql.includes('FROM rbac.permissions')) {
      return { rows: [] };
    }
    // autoWireDefaultRoles: SELECT zitadel_project_id
    if (sql.includes('SELECT zitadel_project_id')) {
      return { rows: [{ zitadel_project_id: 'proj-1' }] };
    }
    // upsertManifestRole INSERT
    if (sql.includes('INSERT INTO rbac.roles')) {
      return { rows: [], rowCount: 1 };
    }
    // INSERT role_permissions
    if (sql.includes('INSERT INTO rbac.role_permissions')) {
      return { rows: [], rowCount: 1 };
    }
    // BEGIN / COMMIT / ROLLBACK / anything else
    return { rows: [], rowCount: 0 };
  });
  void schemaVersion;
}

const v1Yaml = `
schema: '1'
service: onelog-agent
version: '0.1.0'
permissions:
  - id: onelog-agent:chat.query
    description: Query chat
default_roles:
  - key: onelog-agent.viewer
    permissions:
      - onelog-agent:chat.query
`.trim();

const v2Yaml = `
schema: '2'
service: onelog-agent
version: '0.2.0'
tenant_aware: false
permissions:
  - id: onelog-agent:chat.query
    description: Query chat
  - id: onelog-agent:alert.push
    description: Push alerts
default_roles:
  - key: onelog-agent.viewer
    permissions:
      - onelog-agent:chat.query
    can_grant: []
  - key: onelog-agent.admin
    parent_key: onelog-agent.viewer
    permissions:
      - onelog-agent:alert.push
    can_grant:
      - onelog-agent.viewer
`.trim();

describe('POST /v1/admin/apps/:id/sync-manifest-inline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisSetex.mockResolvedValue('OK');
    stubDbFor('1');
  });

  it('parses v1 YAML and returns diff shape (schema=1)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/apps/${APP_ID}/sync-manifest-inline`,
      payload: { format: 'yaml', content: v1Yaml },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      manifest_sha256: string;
      schema: string;
      diff: { counts: Record<string, number> };
    };
    expect(body.status).toBe('fetched');
    expect(body.schema).toBe('1');
    expect(body.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body.diff.counts.add).toBe(1);
    expect(mockRedisSetex).toHaveBeenCalled();
    await app.close();
  });

  it('parses v2 YAML with hierarchy + can_grant (schema=2)', async () => {
    stubDbFor('2');
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/apps/${APP_ID}/sync-manifest-inline`,
      payload: { format: 'yaml', content: v2Yaml },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { schema: string; diff: { counts: Record<string, number> } };
    expect(body.schema).toBe('2');
    expect(body.diff.counts.add).toBe(2);
    await app.close();
  });

  it('parses JSON payload equivalent to YAML', async () => {
    const app = await buildTestApp();
    const jsonPayload = JSON.stringify({
      schema: '1',
      service: 'onelog-agent',
      version: '0.1.0',
      permissions: [{ id: 'onelog-agent:chat.query', description: 'Query chat' }],
      default_roles: [{ key: 'onelog-agent.viewer', permissions: ['onelog-agent:chat.query'] }],
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/apps/${APP_ID}/sync-manifest-inline`,
      payload: { format: 'json', content: jsonPayload },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 400 on malformed YAML with parse error detail', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/apps/${APP_ID}/sync-manifest-inline`,
      payload: { format: 'yaml', content: 'schema: "1"\n  invalid: [unclosed' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; detail: string };
    expect(body.error).toContain('YAML');
    expect(body.detail).toBeTruthy();
    await app.close();
  });

  it('returns 400 on malformed JSON', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/apps/${APP_ID}/sync-manifest-inline`,
      payload: { format: 'json', content: '{ not: json' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toContain('JSON');
    await app.close();
  });

  it('returns 400 on manifest schema validation failure (bad service prefix)', async () => {
    const app = await buildTestApp();
    const badV1 = v1Yaml.replace('service: onelog-agent', 'service: attacker');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/apps/${APP_ID}/sync-manifest-inline`,
      payload: { format: 'yaml', content: badV1 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; errors: unknown[] };
    expect(body.error).toContain('Manifest validation failed');
    expect(body.errors.length).toBeGreaterThan(0);
    await app.close();
  });

  it('returns 400 when content exceeds 100KB cap', async () => {
    const app = await buildTestApp();
    const huge = 'x'.repeat(100 * 1024 + 1);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/apps/${APP_ID}/sync-manifest-inline`,
      payload: { format: 'yaml', content: huge },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 when app id not found in rbac.apps', async () => {
    mockWriterQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, slug, name, manifest_url')) return { rows: [] };
      return { rows: [] };
    });
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/apps/${APP_ID}/sync-manifest-inline`,
      payload: { format: 'yaml', content: v1Yaml },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('produces same sha256 for equivalent yaml + json (canonical hashing)', async () => {
    const app = await buildTestApp();
    const jsonPayload = JSON.stringify({
      schema: '1',
      service: 'onelog-agent',
      version: '0.1.0',
      permissions: [{ id: 'onelog-agent:chat.query', description: 'Query chat' }],
      default_roles: [{ key: 'onelog-agent.viewer', permissions: ['onelog-agent:chat.query'] }],
    });

    const [rYaml, rJson] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v1/admin/apps/${APP_ID}/sync-manifest-inline`,
        payload: { format: 'yaml', content: v1Yaml },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/admin/apps/${APP_ID}/sync-manifest-inline`,
        payload: { format: 'json', content: jsonPayload },
      }),
    ]);
    expect(rYaml.statusCode).toBe(200);
    expect(rJson.statusCode).toBe(200);
    const yamlSha = (rYaml.json() as { manifest_sha256: string }).manifest_sha256;
    const jsonSha = (rJson.json() as { manifest_sha256: string }).manifest_sha256;
    expect(yamlSha).toBe(jsonSha);
    await app.close();
  });
});
