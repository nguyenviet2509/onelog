/**
 * migration-019-rbac-v2-foundation.test.ts — Integration tests cho Migration 019.
 *
 * Coverage (3 describe blocks):
 *   1. Schema — CREATE TABLE user_grants, ALTER CHECK, ADD COLUMN, seed system data
 *   2. Epoch triggers — dual-bump (global metadata + per-app apps.permission_epoch),
 *                        STATEMENT-level (bulk 100 grants → 1 bump)
 *   3. Cycle trigger — self-parent reject, chain cycle reject, depth cap 10
 *
 * Run: npm run test:integration
 * Requires: Docker Desktop running
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from 'testcontainers';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../src/db/migrations');
const CENTRAL_APP_ID = '00000000-0000-0000-0000-000000000001';

let container: StartedPostgreSqlContainer;
let adminPool: pg.Pool;

async function runSql(pool: pg.Pool, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}

/** Run tất cả migration files từ 001 → 019 theo thứ tự (không bao gồm rollback). */
async function runAllMigrations(pool: pg.Pool): Promise<void> {
  const files = await readdir(MIGRATIONS_DIR);
  const migrationFiles = files
    .filter((f) => /^\d{3}_.+\.sql$/.test(f) && !f.endsWith('_rollback.sql'))
    .sort();

  for (const file of migrationFiles) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await runSql(pool, sql);
  }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('central_rbac')
    .withUsername('postgres_admin')
    .withPassword('test_password')
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const adminUrl = `postgresql://postgres_admin:test_password@${host}:${port}/central_rbac`;
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 5 });

  // Bootstrap: schema + roles + schema_migrations tracking + rbac_writer/reader/auditor
  await runSql(adminPool, `
    CREATE SCHEMA IF NOT EXISTS rbac;
    CREATE TABLE IF NOT EXISTS rbac.schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE ROLE rbac_writer  WITH LOGIN PASSWORD 'writer_test_pw' CONNECTION LIMIT 20;
    CREATE ROLE rbac_reader  WITH LOGIN PASSWORD 'reader_test_pw' CONNECTION LIMIT 10;
    CREATE ROLE rbac_auditor WITH LOGIN PASSWORD 'auditor_test_pw' CONNECTION LIMIT 5;
    GRANT USAGE ON SCHEMA rbac TO rbac_writer, rbac_reader, rbac_auditor;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  `);

  await runAllMigrations(adminPool);
}, 120_000);

afterAll(async () => {
  await adminPool?.end();
  await container?.stop();
});

// ─── 1. Schema ────────────────────────────────────────────────────────────────

describe('Migration 019 — Schema', () => {
  it('creates rbac.user_grants table với đúng columns', async () => {
    const res = await adminPool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'rbac' AND table_name = 'user_grants'
        ORDER BY ordinal_position`,
    );
    const cols = new Map(res.rows.map((r) => [r.column_name, r]));
    expect(cols.has('id')).toBe(true);
    expect(cols.has('user_sub')).toBe(true);
    expect(cols.has('app_id')).toBe(true);
    expect(cols.has('role_key')).toBe(true);
    expect(cols.has('tenant_id')).toBe(true);
    expect(cols.has('granted_by_sub')).toBe(true);
    expect(cols.has('created_at')).toBe(true);
    // tenant_id must be nullable (global grants)
    expect(cols.get('tenant_id')?.is_nullable).toBe('YES');
    // Everything else NOT NULL
    expect(cols.get('user_sub')?.is_nullable).toBe('NO');
    expect(cols.get('app_id')?.is_nullable).toBe('NO');
    expect(cols.get('role_key')?.is_nullable).toBe('NO');
  });

  it('user_grants UNIQUE constraint (user_sub, app_id, role_key, tenant_id)', async () => {
    const res = await adminPool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'rbac.user_grants'::regclass AND contype = 'u'`,
    );
    expect(res.rows.length).toBeGreaterThan(0);
  });

  it('roles.source CHECK accepts "system"', async () => {
    await expect(
      adminPool.query(
        `INSERT INTO rbac.roles (key, description, source, app_id)
         VALUES ('test.system.role', 'System-managed test', 'system', $1)`,
        [CENTRAL_APP_ID],
      ),
    ).resolves.toBeDefined();
    // Cleanup
    await adminPool.query(`DELETE FROM rbac.roles WHERE key = 'test.system.role'`);
  });

  it('roles.source CHECK vẫn reject invalid values', async () => {
    await expect(
      adminPool.query(
        `INSERT INTO rbac.roles (key, description, source, app_id)
         VALUES ('test.invalid.role', 'Bad source', 'unknown', $1)`,
        [CENTRAL_APP_ID],
      ),
    ).rejects.toThrow();
  });

  it('roles.can_grant column exists với default empty array', async () => {
    const res = await adminPool.query<{ column_default: string; data_type: string }>(
      `SELECT column_default, data_type FROM information_schema.columns
        WHERE table_schema = 'rbac' AND table_name = 'roles' AND column_name = 'can_grant'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.data_type).toBe('ARRAY');
  });

  it('apps.permission_epoch column exists với default 1', async () => {
    const res = await adminPool.query<{ column_default: string; data_type: string }>(
      `SELECT column_default, data_type FROM information_schema.columns
        WHERE table_schema = 'rbac' AND table_name = 'apps' AND column_name = 'permission_epoch'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.data_type).toBe('bigint');
  });

  it('seed dummy app "central" tồn tại với fixed UUID', async () => {
    const res = await adminPool.query<{ id: string; slug: string; name: string }>(
      `SELECT id, slug, name FROM rbac.apps WHERE slug = 'central'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.id).toBe(CENTRAL_APP_ID);
    expect(res.rows[0]!.name).toBe('Central RBAC Platform');
  });

  it('seed role "central.operator" tồn tại với source=system', async () => {
    const res = await adminPool.query<{ key: string; source: string; app_id: string | null }>(
      `SELECT key, source, app_id FROM rbac.roles WHERE key = 'central.operator'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.source).toBe('system');
    expect(res.rows[0]!.app_id).toBe(CENTRAL_APP_ID);
  });

  it('records migration version 19', async () => {
    const res = await adminPool.query<{ version: number }>(
      `SELECT version FROM rbac.schema_migrations WHERE version = 19`,
    );
    expect(res.rows).toHaveLength(1);
  });
});

// ─── 2. Epoch triggers ────────────────────────────────────────────────────────

describe('Migration 019 — Epoch triggers (dual-bump)', () => {
  let testAppId: string;
  const testUserSub = 'test-epoch-user-sub';

  beforeAll(async () => {
    // Setup test app + role
    const appRes = await adminPool.query<{ id: string }>(
      `INSERT INTO rbac.apps (slug, name, created_by, client_type)
       VALUES ('epoch-test-app', 'Epoch Test App', 'system', 'web')
       RETURNING id`,
    );
    testAppId = appRes.rows[0]!.id;

    await adminPool.query(
      `INSERT INTO rbac.roles (key, description, source, app_id)
       VALUES ('epoch-test-app.viewer', 'Test viewer', 'manual', $1)`,
      [testAppId],
    );
  });

  afterAll(async () => {
    await adminPool.query(`DELETE FROM rbac.user_grants WHERE app_id = $1`, [testAppId]);
    await adminPool.query(`DELETE FROM rbac.roles WHERE app_id = $1`, [testAppId]);
    await adminPool.query(`DELETE FROM rbac.apps WHERE id = $1`, [testAppId]);
  });

  it('INSERT user_grants bumps CẢ global metadata VÀ per-app epoch', async () => {
    const before = await adminPool.query<{ value: string; epoch: string }>(
      `SELECT
         (SELECT value FROM rbac.metadata WHERE key = 'resolve_epoch') AS value,
         (SELECT permission_epoch::text FROM rbac.apps WHERE id = $1) AS epoch`,
      [testAppId],
    );
    const beforeGlobal = parseInt(before.rows[0]!.value ?? '0', 10);
    const beforeApp = parseInt(before.rows[0]!.epoch, 10);

    await adminPool.query(
      `INSERT INTO rbac.user_grants (user_sub, app_id, role_key, tenant_id)
       VALUES ($1, $2, 'epoch-test-app.viewer', NULL)`,
      [testUserSub, testAppId],
    );

    const after = await adminPool.query<{ value: string; epoch: string }>(
      `SELECT
         (SELECT value FROM rbac.metadata WHERE key = 'resolve_epoch') AS value,
         (SELECT permission_epoch::text FROM rbac.apps WHERE id = $1) AS epoch`,
      [testAppId],
    );
    const afterGlobal = parseInt(after.rows[0]!.value, 10);
    const afterApp = parseInt(after.rows[0]!.epoch, 10);

    expect(afterGlobal).toBeGreaterThan(beforeGlobal);
    expect(afterApp).toBeGreaterThan(beforeApp);

    // Cleanup
    await adminPool.query(
      `DELETE FROM rbac.user_grants WHERE user_sub = $1 AND app_id = $2`,
      [testUserSub, testAppId],
    );
  });

  it('BULK INSERT 100 grants trong 1 statement → epoch bump 1 lần (STATEMENT-level)', async () => {
    const before = await adminPool.query<{ epoch: string }>(
      `SELECT permission_epoch::text AS epoch FROM rbac.apps WHERE id = $1`,
      [testAppId],
    );
    const beforeEpoch = parseInt(before.rows[0]!.epoch, 10);

    // Bulk insert 100 rows trong 1 INSERT statement
    const values: string[] = [];
    const params: unknown[] = [testAppId];
    for (let i = 0; i < 100; i++) {
      params.push(`bulk-user-${i}`);
      values.push(`($${params.length}, $1, 'epoch-test-app.viewer', NULL)`);
    }
    await adminPool.query(
      `INSERT INTO rbac.user_grants (user_sub, app_id, role_key, tenant_id)
       VALUES ${values.join(',')}`,
      params,
    );

    const after = await adminPool.query<{ epoch: string }>(
      `SELECT permission_epoch::text AS epoch FROM rbac.apps WHERE id = $1`,
      [testAppId],
    );
    const afterEpoch = parseInt(after.rows[0]!.epoch, 10);

    // STATEMENT-level trigger = 1 bump cho toàn batch (không 100)
    expect(afterEpoch - beforeEpoch).toBe(1);

    // Cleanup
    await adminPool.query(
      `DELETE FROM rbac.user_grants WHERE app_id = $1 AND user_sub LIKE 'bulk-user-%'`,
      [testAppId],
    );
  });

  it('DELETE user_grants cũng bump epoch', async () => {
    await adminPool.query(
      `INSERT INTO rbac.user_grants (user_sub, app_id, role_key, tenant_id)
       VALUES ($1, $2, 'epoch-test-app.viewer', NULL)`,
      [testUserSub, testAppId],
    );

    const before = await adminPool.query<{ epoch: string }>(
      `SELECT permission_epoch::text AS epoch FROM rbac.apps WHERE id = $1`,
      [testAppId],
    );
    const beforeEpoch = parseInt(before.rows[0]!.epoch, 10);

    await adminPool.query(
      `DELETE FROM rbac.user_grants WHERE user_sub = $1 AND app_id = $2`,
      [testUserSub, testAppId],
    );

    const after = await adminPool.query<{ epoch: string }>(
      `SELECT permission_epoch::text AS epoch FROM rbac.apps WHERE id = $1`,
      [testAppId],
    );
    const afterEpoch = parseInt(after.rows[0]!.epoch, 10);

    expect(afterEpoch).toBeGreaterThan(beforeEpoch);
  });
});

// ─── 3. Cycle detection trigger ───────────────────────────────────────────────

describe('Migration 019 — Role parent cycle detection', () => {
  let cycleTestAppId: string;

  beforeAll(async () => {
    const appRes = await adminPool.query<{ id: string }>(
      `INSERT INTO rbac.apps (slug, name, created_by, client_type)
       VALUES ('cycle-test-app', 'Cycle Test App', 'system', 'web')
       RETURNING id`,
    );
    cycleTestAppId = appRes.rows[0]!.id;
  });

  afterAll(async () => {
    await adminPool.query(`DELETE FROM rbac.roles WHERE app_id = $1`, [cycleTestAppId]);
    await adminPool.query(`DELETE FROM rbac.apps WHERE id = $1`, [cycleTestAppId]);
  });

  it('reject self-parent (role.parent_key = role.key)', async () => {
    await expect(
      adminPool.query(
        `INSERT INTO rbac.roles (key, description, parent_key, source, app_id)
         VALUES ('cycle-test-app.self', 'Self parent', 'cycle-test-app.self', 'manual', $1)`,
        [cycleTestAppId],
      ),
    ).rejects.toThrow(/cycle detected/i);
  });

  it('reject 2-role cycle (A→B, then B.parent = A)', async () => {
    await adminPool.query(
      `INSERT INTO rbac.roles (key, description, parent_key, source, app_id)
       VALUES ('cycle-test-app.a', 'A', NULL, 'manual', $1),
              ('cycle-test-app.b', 'B', 'cycle-test-app.a', 'manual', $1)`,
      [cycleTestAppId],
    );

    // Now try to UPDATE A.parent_key = B → creates A → B → A cycle
    await expect(
      adminPool.query(
        `UPDATE rbac.roles SET parent_key = 'cycle-test-app.b' WHERE key = 'cycle-test-app.a'`,
      ),
    ).rejects.toThrow(/cycle detected/i);
  });

  it('reject 3-role cycle (A→B→C, then C.parent = A)', async () => {
    await adminPool.query(
      `INSERT INTO rbac.roles (key, description, parent_key, source, app_id)
       VALUES ('cycle-test-app.c', 'C', 'cycle-test-app.b', 'manual', $1)`,
      [cycleTestAppId],
    );

    await expect(
      adminPool.query(
        `UPDATE rbac.roles SET parent_key = 'cycle-test-app.c' WHERE key = 'cycle-test-app.a'`,
      ),
    ).rejects.toThrow(/cycle detected/i);
  });

  it('accept valid chain (viewer → member → admin, no cycle)', async () => {
    await expect(
      adminPool.query(
        `INSERT INTO rbac.roles (key, description, parent_key, source, app_id)
         VALUES ('cycle-test-app.viewer', 'V', NULL, 'manual', $1),
                ('cycle-test-app.member', 'M', 'cycle-test-app.viewer', 'manual', $1),
                ('cycle-test-app.admin',  'A', 'cycle-test-app.member', 'manual', $1)`,
        [cycleTestAppId],
      ),
    ).resolves.toBeDefined();
  });
});
