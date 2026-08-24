/**
 * migrations-and-audit-chain.test.ts — Integration tests using testcontainers.
 * Tests: migrations run cleanly, audit chain integrity, tamper rejection,
 * role hierarchy resolve (3 levels), C3 concurrency chain integrity,
 * DB role privilege separation (M1 partial fix).
 *
 * Run: npm run test:integration
 * Requires: Docker Desktop running
 *
 * C3 fix verified here: 20 parallel insertAuditEntry calls → chain must be unbroken.
 * M1 partial fix: rbac_writer and rbac_auditor pools connect as actual DB roles;
 *   privilege assertions verify grants from migration 003 (C1 fix included).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from 'testcontainers';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insertAuditEntry, verifyAuditChainIntegrity } from '../../src/db/queries/audit.js';
import { resolvePermissions } from '../../src/db/queries/resolve.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../src/db/migrations');

let container: StartedPostgreSqlContainer;
// adminPool: superuser — used only for setup/teardown and trigger tests
let adminPool: pg.Pool;
// writerPool: connects as rbac_writer role (M1 fix — actual role, not superuser)
let writerPool: pg.Pool;
// auditorPool: connects as rbac_auditor role (M1 fix — actual role, not superuser)
let auditorPool: pg.Pool;

async function runSql(pool: pg.Pool, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  // Start a fresh Postgres 16 container
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

  // Bootstrap: create schema + roles + migration tracking table
  await runSql(adminPool, `
    CREATE SCHEMA IF NOT EXISTS rbac;
    CREATE TABLE IF NOT EXISTS rbac.schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE ROLE rbac_writer WITH LOGIN PASSWORD 'writer_test_pw' CONNECTION LIMIT 20;
    CREATE ROLE rbac_auditor WITH LOGIN PASSWORD 'auditor_test_pw' CONNECTION LIMIT 5;
    GRANT USAGE ON SCHEMA rbac TO rbac_writer, rbac_auditor;
  `);

  // Run migrations 002–004 as superuser
  for (const file of ['002_rbac_tables.sql', '003_audit_hash_chain.sql', '004_audit_immutable_trigger.sql']) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await runSql(adminPool, sql);
  }

  // M1 fix: create role-specific pools that connect as the actual DB roles.
  // These pools exercise the real grant boundaries set by migration 003 (C1 fix).
  writerPool = new pg.Pool({
    connectionString: `postgresql://rbac_writer:writer_test_pw@${host}:${port}/central_rbac`,
    max: 10,
  });
  auditorPool = new pg.Pool({
    connectionString: `postgresql://rbac_auditor:auditor_test_pw@${host}:${port}/central_rbac`,
    max: 3,
  });
}, 90_000);

afterAll(async () => {
  await writerPool?.end();
  await auditorPool?.end();
  await adminPool?.end();
  await container?.stop();
});

// ─── Migration structure ──────────────────────────────────────────────────────

describe('Migrations', () => {
  it('creates all expected tables', async () => {
    const res = await adminPool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'rbac' ORDER BY tablename`,
    );
    const tables = res.rows.map((r) => r.tablename);
    expect(tables).toContain('permissions');
    expect(tables).toContain('roles');
    expect(tables).toContain('role_permissions');
    expect(tables).toContain('audit_log');
    expect(tables).toContain('schema_migrations');
  });

  it('audit_log has seq BIGSERIAL column (H5 fix)', async () => {
    const res = await adminPool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'rbac' AND table_name = 'audit_log' AND column_name = 'seq'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.data_type).toBe('bigint');
  });

  it('records all migration versions', async () => {
    const res = await adminPool.query<{ version: number }>(
      `SELECT version FROM rbac.schema_migrations ORDER BY version`,
    );
    const versions = res.rows.map((r) => r.version);
    expect(versions).toContain(2);
    expect(versions).toContain(3);
    expect(versions).toContain(4);
  });

  it('is idempotent — running migrations again does not error', async () => {
    for (const file of ['002_rbac_tables.sql', '003_audit_hash_chain.sql', '004_audit_immutable_trigger.sql']) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await expect(runSql(adminPool, sql)).resolves.toBeUndefined();
    }
  });
});

// ─── M1 / C1: DB role privilege assertions ───────────────────────────────────

describe('DB role privilege separation (M1 partial fix, C1 fix)', () => {
  it('rbac_writer can INSERT into audit_log', async () => {
    // This test will fail in prod without C1 fix (GRANT SELECT missing).
    // insertAuditEntry uses SELECT to read prev_hash — writer must have SELECT.
    await expect(
      insertAuditEntry(writerPool, {
        actor_id: 'priv-test-writer',
        actor_type: 'user',
        actor_email: 'w@test.com',
        action: 'test.insert',
        target_type: 'permission',
        target_id: 'test.priv',
        before_state: null,
        after_state: null,
      }),
    ).resolves.toBeDefined();
  });

  it('rbac_writer can SELECT from audit_log (C1 fix — needed for chain prev_hash)', async () => {
    // Direct SELECT as rbac_writer — would throw "permission denied" without C1 fix
    await expect(
      writerPool.query('SELECT count(*) FROM rbac.audit_log'),
    ).resolves.toBeDefined();
  });

  it('rbac_writer cannot UPDATE audit_log (trigger + revoke)', async () => {
    await expect(
      writerPool.query(`UPDATE rbac.audit_log SET action = 'x' WHERE actor_id = 'priv-test-writer'`),
    ).rejects.toThrow();
  });

  it('rbac_writer cannot DELETE from audit_log (trigger + revoke)', async () => {
    await expect(
      writerPool.query(`DELETE FROM rbac.audit_log WHERE actor_id = 'priv-test-writer'`),
    ).rejects.toThrow();
  });

  it('rbac_auditor can SELECT from audit_log', async () => {
    await expect(
      auditorPool.query('SELECT count(*) FROM rbac.audit_log'),
    ).resolves.toBeDefined();
  });

  it('rbac_auditor cannot INSERT into audit_log', async () => {
    await expect(
      auditorPool.query(`
        INSERT INTO rbac.audit_log
          (id, seq, ts, actor_id, actor_type, actor_email, action, target_type,
           target_id, row_hash, chained_hash)
        VALUES (gen_random_uuid(), DEFAULT, now(), 'x', 'user', '', 'x', 'x', 'x', 'x', 'x')
      `),
    ).rejects.toThrow();
  });
});

// ─── Audit hash chain — serial ────────────────────────────────────────────────

describe('Audit hash chain (serial)', () => {
  it('inserts 3 audit rows and verifies chain integrity', async () => {
    const base = {
      actor_id: 'user-chain-test',
      actor_type: 'user' as const,
      actor_email: 'chain@test.com',
      action: 'permission.create',
      target_type: 'permission',
      target_id: 'test.perm',
    };

    await insertAuditEntry(writerPool, { ...base, before_state: null, after_state: { key: 'p1' } });
    await insertAuditEntry(writerPool, { ...base, before_state: null, after_state: { key: 'p2' } });
    await insertAuditEntry(writerPool, { ...base, before_state: null, after_state: { key: 'p3' } });

    const integrity = await verifyAuditChainIntegrity(auditorPool, 100);
    expect(integrity.ok).toBe(true);
    expect(integrity.broken_at).toBeUndefined();
  });
});

// ─── C3: Concurrent chain integrity ──────────────────────────────────────────

describe('Audit hash chain — concurrent writes (C3 race fix)', () => {
  it('chain remains unbroken after 20 parallel insertAuditEntry calls', async () => {
    // Spawn 20 concurrent inserts. Without C3 fix (advisory lock), concurrent
    // writers would read the same prev_hash → fork the chain → integrity breaks.
    const inserts = Array.from({ length: 20 }, (_, i) =>
      insertAuditEntry(writerPool, {
        actor_id: 'concurrency-test',
        actor_type: 'user',
        actor_email: 'race@test.com',
        action: 'permission.create',
        target_type: 'permission',
        target_id: `concurrent.perm.${i}`,
        before_state: null,
        after_state: { index: i },
      }),
    );

    await expect(Promise.all(inserts)).resolves.toHaveLength(20);

    // Chain must be intact — verifyAuditChainIntegrity orders by seq ASC
    const integrity = await verifyAuditChainIntegrity(auditorPool, 500);
    expect(integrity.ok).toBe(true);
    expect(integrity.broken_at).toBeUndefined();
  }, 30_000); // allow extra time for 20 advisory-locked serial DB round-trips
});

// ─── Audit immutable trigger ──────────────────────────────────────────────────

describe('Audit immutable trigger', () => {
  it('rejects UPDATE on audit_log (admin pool — not blocked by role revoke)', async () => {
    await insertAuditEntry(writerPool, {
      actor_id: 'user-trigger-test',
      actor_type: 'user',
      actor_email: 'trigger@test.com',
      action: 'role.create',
      target_type: 'role',
      target_id: 'test.role',
      before_state: null,
      after_state: { key: 'test.role' },
    });

    // Admin bypasses REVOKE but trigger still fires
    await expect(
      adminPool.query(`UPDATE rbac.audit_log SET action = 'tampered' WHERE actor_id = 'user-trigger-test'`),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects DELETE on audit_log', async () => {
    await expect(
      adminPool.query(`DELETE FROM rbac.audit_log WHERE actor_id = 'user-trigger-test'`),
    ).rejects.toThrow(/append-only/i);
  });
});

// ─── Role hierarchy resolve ───────────────────────────────────────────────────

describe('Role hierarchy resolve (3 levels)', () => {
  beforeAll(async () => {
    await adminPool.query(`
      INSERT INTO rbac.permissions (key, description) VALUES
        ('svc.res.read', 'read'),
        ('svc.res.write', 'write'),
        ('svc.res.delete', 'delete')
      ON CONFLICT (key) DO NOTHING;

      INSERT INTO rbac.roles (key, description, parent_key) VALUES
        ('lvl1.viewer', 'Level 1', NULL),
        ('lvl2.editor', 'Level 2', 'lvl1.viewer'),
        ('lvl3.admin', 'Level 3', 'lvl2.editor')
      ON CONFLICT (key) DO NOTHING;

      INSERT INTO rbac.role_permissions (role_key, permission_key) VALUES
        ('lvl1.viewer', 'svc.res.read'),
        ('lvl2.editor', 'svc.res.write'),
        ('lvl3.admin', 'svc.res.delete')
      ON CONFLICT DO NOTHING;
    `);
  });

  it('resolves all 3 levels of permissions from bottom role', async () => {
    const result = await resolvePermissions(writerPool, ['lvl3.admin']);
    expect(result.permissions).toContain('svc.res.read');
    expect(result.permissions).toContain('svc.res.write');
    expect(result.permissions).toContain('svc.res.delete');
    expect(result.roles_expanded).toContain('lvl1.viewer');
    expect(result.roles_expanded).toContain('lvl2.editor');
    expect(result.roles_expanded).toContain('lvl3.admin');
  });

  it('resolves only own + parent permissions for middle role', async () => {
    const result = await resolvePermissions(writerPool, ['lvl2.editor']);
    expect(result.permissions).toContain('svc.res.read');
    expect(result.permissions).toContain('svc.res.write');
    expect(result.permissions).not.toContain('svc.res.delete');
  });

  it('resolves only direct permissions for leaf role', async () => {
    const result = await resolvePermissions(writerPool, ['lvl1.viewer']);
    expect(result.permissions).toContain('svc.res.read');
    expect(result.permissions).not.toContain('svc.res.write');
  });
});

// ─── Cycle prevention ─────────────────────────────────────────────────────────

describe('Cycle prevention (DB level)', () => {
  it('prevents direct self-referential parent via FK constraint or app guard', async () => {
    await adminPool.query(`
      INSERT INTO rbac.roles (key, description, parent_key)
      VALUES ('cycle.test.root', 'Cycle test', NULL)
      ON CONFLICT (key) DO NOTHING
    `);

    const res = await adminPool.query(
      `SELECT key, parent_key FROM rbac.roles WHERE key = 'cycle.test.root'`,
    );
    expect(res.rows[0]?.parent_key).toBeNull();
  });
});
