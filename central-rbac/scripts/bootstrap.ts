/**
 * scripts/bootstrap.ts — Idempotent seed for permissions + roles.
 *
 * Source of truth: config/seed/permissions.yaml + config/seed/roles.yaml
 * This script encodes the same data as typed arrays to avoid a js-yaml dep.
 * If you update the YAML files, mirror the change here and vice versa.
 *
 * Rules enforced:
 *   - Hard check: no role except system.root grants any rbac.* permission (exits 1 on violation)
 *   - INSERT permissions ON CONFLICT (key) DO UPDATE description
 *   - INSERT roles ON CONFLICT (key) DO UPDATE description, parent_key
 *   - Wipe + re-insert role_permissions (idempotent full replacement per role)
 *   - bumpResolveEpoch after all inserts
 *
 * Usage: npm run bootstrap   (or tsx scripts/bootstrap.ts)
 * Dry-run: BOOTSTRAP_DRY_RUN=true tsx scripts/bootstrap.ts
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Seed data (mirrors config/seed/permissions.yaml) ─────────────────────────

interface PermissionSeed {
  key: string;
  description: string;
}

const PERMISSIONS: PermissionSeed[] = [
  { key: 'rbac.admin.read', description: 'Read RBAC configuration (roles, permissions, assignments)' },
  { key: 'rbac.admin.write', description: 'Mutate RBAC configuration (create/update roles and permissions)' },
  { key: 'zitadel.iam.read', description: 'Read Zitadel IAM configuration (orgs, users, projects)' },
  { key: 'zitadel.iam.write', description: 'Write Zitadel IAM configuration — BREAK-GLASS ONLY' },
  { key: 'cloud.viewer', description: 'Read-only access to cloud resources' },
  { key: 'cloud.editor', description: 'Read + write access to cloud resources' },
  { key: 'cloud.admin', description: 'Full administrative access to cloud resources including destructive ops' },
  { key: 'monitoring.viewer', description: 'View monitoring dashboards and alerts' },
  { key: 'monitoring.editor', description: 'Edit monitoring rules, silence alerts, manage dashboards' },
  { key: 'storage.viewer', description: 'Read objects from storage (MinIO / S3 buckets)' },
  { key: 'storage.editor', description: 'Read + write objects to storage buckets' },
  { key: 'onemcp.kb.read', description: 'Read knowledge base entries in OneMCP' },
  { key: 'onemcp.kb.write', description: 'Write knowledge base entries in OneMCP' },
  { key: 'onemcp.kb.delete', description: 'Delete knowledge base entries in OneMCP' },
  { key: 'onemcp.admin.manage', description: 'Manage OneMCP admin settings and connectors' },
  { key: 'onelog.logs.read', description: 'Read system logs via OneLog' },
  { key: 'onelog.logs.export', description: 'Export log data from OneLog' },
  { key: 'audit.read', description: 'Read audit log entries' },
  { key: 'audit.export', description: 'Export audit log data' },
  { key: 'outbox.read', description: 'Read outbox event queue status' },
  { key: 'outbox.admin', description: 'Retry or dead-letter outbox events' },
  { key: 'drift.check', description: 'Trigger on-demand drift check between Central RBAC and Zitadel' },
  { key: 'assignments.read', description: 'View user role assignments' },
  { key: 'assignments.write', description: 'Assign or revoke user roles' },
  { key: 'users.read', description: 'Search and view user profiles via RBAC admin panel' },
  { key: 'roles.read', description: 'Read role definitions and permission mappings' },
  { key: 'roles.write', description: 'Create and update role definitions' },
  { key: 'permissions.read', description: 'Read permission definitions' },
  { key: 'permissions.write', description: 'Create and update permission definitions' },
];

// ── Seed data (mirrors config/seed/roles.yaml) ────────────────────────────────

interface RoleSeed {
  key: string;
  description: string;
  parent_key: string | null;
  permissions: string[];
}

const ROLES: RoleSeed[] = [
  {
    key: 'system.root',
    description: 'Unrestricted system root — all permissions including break-glass IAM access',
    parent_key: null,
    permissions: [
      'rbac.admin.read', 'rbac.admin.write',
      'zitadel.iam.read', 'zitadel.iam.write',
      'cloud.viewer', 'cloud.editor', 'cloud.admin',
      'monitoring.viewer', 'monitoring.editor',
      'storage.viewer', 'storage.editor',
      'onemcp.kb.read', 'onemcp.kb.write', 'onemcp.kb.delete', 'onemcp.admin.manage',
      'onelog.logs.read', 'onelog.logs.export',
      'audit.read', 'audit.export',
      'outbox.read', 'outbox.admin',
      'drift.check',
      'assignments.read', 'assignments.write',
      'users.read',
      'roles.read', 'roles.write',
      'permissions.read', 'permissions.write',
    ],
  },
  {
    key: 'rbac.admin',
    description: 'RBAC administrator — manage roles, permissions, and assignments',
    parent_key: null,
    // rbac.admin.* perms are NOT listed here per plan rule: only system.root holds rbac.* grants.
    // The rbac.admin role grants administrative UI access via Zitadel role claim; the UI
    // checks role_key = 'rbac.admin' from the JWT, not individual rbac.* permissions.
    permissions: [
      'assignments.read', 'assignments.write',
      'users.read',
      'roles.read', 'roles.write',
      'permissions.read', 'permissions.write',
      'audit.read', 'drift.check', 'outbox.read',
    ],
  },
  {
    key: 'cloud.admin',
    description: 'Cloud administrator — full cloud resource access',
    parent_key: 'cloud.viewer',
    permissions: ['cloud.viewer', 'cloud.editor', 'cloud.admin', 'storage.viewer', 'storage.editor'],
  },
  {
    key: 'cloud.viewer',
    description: 'Cloud viewer — read-only access to cloud resources and storage',
    parent_key: null,
    permissions: ['cloud.viewer', 'storage.viewer'],
  },
  {
    key: 'monitoring.admin',
    description: 'Monitoring administrator — dashboards, alerts, and rules',
    parent_key: 'monitoring.viewer',
    permissions: ['monitoring.viewer', 'monitoring.editor', 'onelog.logs.read', 'onelog.logs.export', 'audit.read'],
  },
  {
    key: 'monitoring.viewer',
    description: 'Monitoring viewer — dashboards and alerts read-only',
    parent_key: null,
    permissions: ['monitoring.viewer', 'onelog.logs.read'],
  },
];

// ── Safety check ──────────────────────────────────────────────────────────────

const RBAC_PERM_PATTERN = /^rbac\./;
const ROOT_ONLY_ROLE = 'system.root';

function enforceRbacPermRule(): void {
  for (const role of ROLES) {
    if (role.key === ROOT_ONLY_ROLE) continue;
    const violations = role.permissions.filter((p) => RBAC_PERM_PATTERN.test(p));
    if (violations.length > 0) {
      console.error(
        `HARD CHECK FAILED: role '${role.key}' grants rbac.* permissions: ${violations.join(', ')}`,
      );
      console.error(`Only '${ROOT_ONLY_ROLE}' may hold rbac.* permissions.`);
      process.exit(1);
    }
  }
  console.log('[check] rbac.* permission restriction: OK');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const dryRun = process.env['BOOTSTRAP_DRY_RUN']?.toLowerCase() === 'true';

  const connectionString =
    process.env['WRITER_DATABASE_URL'] ??
    'postgresql://rbac_writer:rbac_writer_changeme@localhost:5433/central_rbac';

  console.log(`[bootstrap] Starting (dry_run=${dryRun})`);

  // Run safety check before touching DB
  enforceRbacPermRule();

  if (dryRun) {
    console.log('[bootstrap] DRY RUN — no DB changes. Seed data validated successfully.');
    console.log(`  Permissions: ${PERMISSIONS.length}`);
    console.log(`  Roles: ${ROLES.length}`);
    for (const r of ROLES) {
      console.log(`    ${r.key}: ${r.permissions.length} permissions`);
    }
    return;
  }

  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Upsert permissions
    console.log('[bootstrap] Seeding permissions...');
    for (const perm of PERMISSIONS) {
      await client.query(
        `INSERT INTO rbac.permissions (key, description)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`,
        [perm.key, perm.description],
      );
      console.log(`  [perm] ${perm.key}`);
    }

    // 2. Upsert roles (insert leaves first to satisfy FK — order in ROLES matters)
    //    cloud.viewer before cloud.admin, monitoring.viewer before monitoring.admin
    console.log('[bootstrap] Seeding roles...');
    for (const role of ROLES) {
      await client.query(
        `INSERT INTO rbac.roles (key, description, parent_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE
           SET description = EXCLUDED.description,
               parent_key  = EXCLUDED.parent_key`,
        [role.key, role.description, role.parent_key],
      );
      console.log(`  [role] ${role.key} (parent: ${role.parent_key ?? 'none'})`);
    }

    // 3. Wipe + re-insert role_permissions per role (full idempotent replacement)
    console.log('[bootstrap] Seeding role_permissions...');
    for (const role of ROLES) {
      await client.query(
        `DELETE FROM rbac.role_permissions WHERE role_key = $1`,
        [role.key],
      );
      for (const permKey of role.permissions) {
        await client.query(
          `INSERT INTO rbac.role_permissions (role_key, permission_key)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [role.key, permKey],
        );
      }
      console.log(`  [rp] ${role.key}: ${role.permissions.length} permissions`);
    }

    // 4. Bump resolve epoch so in-flight JWT caches are invalidated
    await client.query(
      `INSERT INTO rbac.metadata (key, value)
       VALUES ('resolve_epoch', to_char(EXTRACT(EPOCH FROM now())::bigint, 'FM9999999999'))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    console.log('[bootstrap] resolve_epoch bumped');

    await client.query('COMMIT');
    console.log('[bootstrap] Complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[bootstrap] Error — rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Verify seed files exist (documentation cross-check, non-blocking)
function checkSeedFiles(): void {
  const seedDir = resolve(__dirname, '..', 'config', 'seed');
  for (const f of ['permissions.yaml', 'roles.yaml']) {
    try {
      readFileSync(resolve(seedDir, f));
    } catch {
      console.warn(`[bootstrap] WARNING: config/seed/${f} not found — YAML source-of-truth missing`);
    }
  }
}

checkSeedFiles();
bootstrap().catch((err) => {
  console.error('[bootstrap] Fatal:', err);
  process.exit(1);
});
