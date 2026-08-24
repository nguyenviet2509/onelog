/**
 * scripts/bootstrap-dev.ts — Seed dev DB with sample data.
 * Creates sample permissions + roles for local development.
 * Idempotent: uses ON CONFLICT DO NOTHING.
 *
 * Usage: npm run bootstrap-dev
 */
import pg from 'pg';

const connectionString =
  process.env['WRITER_DATABASE_URL'] ??
  'postgresql://rbac_writer:rbac_writer_changeme@localhost:5433/central_rbac';

const PERMISSIONS = [
  { key: 'onemcp.kb.read', description: 'Read knowledge base entries' },
  { key: 'onemcp.kb.write', description: 'Write knowledge base entries' },
  { key: 'onemcp.kb.delete', description: 'Delete knowledge base entries' },
  { key: 'onemcp.admin.manage', description: 'Manage OneMCP admin settings' },
  { key: 'onelog.logs.read', description: 'Read system logs' },
];

const ROLES = [
  { key: 'base.viewer', description: 'Read-only access', parent_key: null },
  { key: 'dept.it.editor', description: 'IT department editor', parent_key: 'base.viewer' },
  { key: 'dept.it.admin', description: 'IT department admin', parent_key: 'dept.it.editor' },
];

const ROLE_PERMISSIONS: Array<{ role_key: string; permission_key: string }> = [
  { role_key: 'base.viewer', permission_key: 'onemcp.kb.read' },
  { role_key: 'base.viewer', permission_key: 'onelog.logs.read' },
  { role_key: 'dept.it.editor', permission_key: 'onemcp.kb.write' },
  { role_key: 'dept.it.admin', permission_key: 'onemcp.kb.delete' },
  { role_key: 'dept.it.admin', permission_key: 'onemcp.admin.manage' },
];

async function bootstrap() {
  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();

  try {
    console.log('Bootstrapping dev data...');

    for (const perm of PERMISSIONS) {
      await client.query(
        `INSERT INTO rbac.permissions (key, description)
         VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [perm.key, perm.description],
      );
      console.log(`  [perm] ${perm.key}`);
    }

    for (const role of ROLES) {
      await client.query(
        `INSERT INTO rbac.roles (key, description, parent_key)
         VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
        [role.key, role.description, role.parent_key],
      );
      console.log(`  [role] ${role.key}`);
    }

    for (const rp of ROLE_PERMISSIONS) {
      await client.query(
        `INSERT INTO rbac.role_permissions (role_key, permission_key)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [rp.role_key, rp.permission_key],
      );
      console.log(`  [rp  ] ${rp.role_key} → ${rp.permission_key}`);
    }

    console.log('Bootstrap complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
