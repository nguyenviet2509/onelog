/**
 * 019-bootstrap-operators.ts — Seed Central operator grants from env.
 *
 * Chạy SAU khi Migration 019 apply. Env-driven để tách bạch dev vs prod:
 *   Dev:  CENTRAL_OPERATOR_SUBS=test-sub-1,test-sub-2 npm run bootstrap-operators
 *   Prod: CENTRAL_OPERATOR_SUBS=<real-subs> npm run bootstrap-operators
 *
 * Idempotent: ON CONFLICT DO NOTHING trên UNIQUE key (user_sub, app_id, role_key, tenant_id).
 * Re-run không tạo duplicate grants hoặc duplicate audit entries.
 *
 * Env vars:
 *   CENTRAL_OPERATOR_SUBS      (required): comma-separated Zitadel user IDs
 *   CENTRAL_OPERATOR_EMAILS    (optional): comma-separated emails cho audit context
 *   WRITER_DATABASE_URL        (fallback local dev URL)
 *
 * Grafana alert khuyến nghị:
 *   SELECT COUNT(*) FROM rbac.user_grants WHERE role_key='central.operator'
 *   Alert if count > expected (từ runbook).
 */
import pg from 'pg';
import { insertAuditEntry } from '../src/db/queries/audit.js';

const CENTRAL_APP_ID = '00000000-0000-0000-0000-000000000001';
const CENTRAL_ROLE_KEY = 'central.operator';

const connectionString =
  process.env['WRITER_DATABASE_URL'] ??
  'postgresql://rbac_writer:rbac_writer_changeme@localhost:5433/central_rbac';

async function main(): Promise<void> {
  const subs = (process.env['CENTRAL_OPERATOR_SUBS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const emails = (process.env['CENTRAL_OPERATOR_EMAILS'] ?? '')
    .split(',')
    .map((s) => s.trim());

  if (subs.length === 0) {
    console.error('ERROR: CENTRAL_OPERATOR_SUBS env required (comma-separated Zitadel user IDs)');
    console.error('Example: CENTRAL_OPERATOR_SUBS=389119521513799683,389119343390097411 npm run bootstrap-operators');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString, max: 1 });

  try {
    console.log(`Bootstrapping ${subs.length} Central operators...`);

    let grantedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i]!;
      const email = emails[i] ?? '';

      // INSERT grant (idempotent qua UNIQUE constraint)
      const grantRes = await pool.query<{ id: string }>(
        `INSERT INTO rbac.user_grants (user_sub, app_id, role_key, tenant_id, granted_by_sub)
         VALUES ($1, $2, $3, NULL, 'system')
         ON CONFLICT (user_sub, app_id, role_key, tenant_id) DO NOTHING
         RETURNING id`,
        [sub, CENTRAL_APP_ID, CENTRAL_ROLE_KEY],
      );

      if (grantRes.rowCount === 0) {
        console.log(`  [skip] ${sub} already has ${CENTRAL_ROLE_KEY} grant`);
        skippedCount++;
        continue;
      }

      // Audit log qua application code (hash chain đúng)
      await insertAuditEntry(pool, {
        actor_id: 'system',
        actor_type: 'service',
        actor_email: '',
        action: 'grant.seed',
        target_type: 'user_grant',
        target_id: sub,
        before_state: null,
        after_state: {
          role_key: CENTRAL_ROLE_KEY,
          app_slug: 'central',
          email,
          source: 'bootstrap-019',
        },
        ip: 'localhost',
        correlation_id: 'bootstrap-operators-019',
        app_id: CENTRAL_APP_ID,
      });

      console.log(`  [grant] ${sub} → ${CENTRAL_ROLE_KEY}${email ? ` (${email})` : ''}`);
      grantedCount++;
    }

    console.log('');
    console.log(`Bootstrap complete:`);
    console.log(`  granted: ${grantedCount}`);
    console.log(`  skipped: ${skippedCount} (already exist)`);
    console.log(`  total:   ${subs.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
