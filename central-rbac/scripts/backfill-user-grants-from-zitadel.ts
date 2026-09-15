/**
 * backfill-user-grants-from-zitadel.ts — One-time migration script for plan 260915-1615 phase 1.
 *
 * Vấn đề: Historical grants (before phase 1 deploy) live trong Zitadel only, không có mirror
 * trong rbac.user_grants. SDK /v2/resolve returns empty permissions → user gets 403.
 *
 * Fix: Iterate qua tất cả apps trong rbac.apps, list grants từ Zitadel, INSERT vào
 * rbac.user_grants (idempotent — WHERE NOT EXISTS chống dup vì UNIQUE constraint không nhóm NULL tenant_id).
 *
 * Usage:
 *   npm run backfill-user-grants -- --dry-run    # log intended INSERTs, không ghi
 *   npm run backfill-user-grants -- --apply      # thực sự ghi
 *
 * Env vars:
 *   WRITER_DATABASE_URL (required)
 *   ZITADEL_MGMT_HOST + auth env (uses zitadel-http.ts)
 *
 * Idempotent: re-run safe. Skip grants có role_key không tồn tại trong rbac.roles (legacy).
 * Skip apps không có zitadel_project_id (self-register chưa complete).
 */
import pg from 'pg';
import { mgmtPost } from '../src/lib/zitadel-http.js';
import { logger } from '../src/lib/logger.js';

interface ZitadelGrantObject {
  grantId?: string;
  id?: string;
  userId?: string;
  projectId?: string;
  orgId?: string;
  roleKeys?: string[];
}

interface AppRow {
  id: string;
  slug: string;
  zitadel_project_id: string;
  zitadel_org_id: string | null;
}

interface Report {
  apps_scanned: number;
  apps_skipped_no_project: number;
  grants_processed: number;
  rows_inserted: number;
  skipped_conflict: number;
  skipped_no_role: number;
  errors: number;
}

async function listGrantsForProject(projectId: string, orgId: string): Promise<
  Array<{ userId: string; roleKeys: string[] }>
> {
  const path = `/management/v1/users/grants/_search`;
  const PAGE_SIZE = 100;
  const MAX_TOTAL = 10_000;
  const accumulated: Array<{ userId: string; roleKeys: string[] }> = [];
  let offset = 0;

  while (true) {
    const res = await mgmtPost(path, orgId, {
      query: { offset: String(offset), limit: PAGE_SIZE },
      queries: [{ projectIdQuery: { projectId } }],
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Zitadel _search HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { result?: ZitadelGrantObject[] };
    const page = (data.result ?? []).map((g) => ({
      userId: g.userId ?? '',
      roleKeys: Array.isArray(g.roleKeys) ? g.roleKeys : [],
    })).filter((g) => g.userId.length > 0);
    accumulated.push(...page);
    if (accumulated.length >= MAX_TOTAL) {
      logger.warn({ projectId, total: accumulated.length }, 'backfill: reached MAX_TOTAL');
      break;
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return accumulated;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');
  if (!dryRun && !apply) {
    console.error('ERROR: pass --dry-run or --apply');
    console.error('Example: npm run backfill-user-grants -- --dry-run');
    process.exit(1);
  }

  const connectionString = process.env['WRITER_DATABASE_URL'];
  if (!connectionString) {
    console.error('ERROR: WRITER_DATABASE_URL env required');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString, max: 2 });
  const report: Report = {
    apps_scanned: 0,
    apps_skipped_no_project: 0,
    grants_processed: 0,
    rows_inserted: 0,
    skipped_conflict: 0,
    skipped_no_role: 0,
    errors: 0,
  };

  try {
    const { rows: apps } = await pool.query<AppRow>(
      `SELECT id, slug, zitadel_project_id, zitadel_org_id
         FROM rbac.apps
        WHERE zitadel_project_id IS NOT NULL
        ORDER BY slug`,
    );
    console.log(`Found ${apps.length} apps với zitadel_project_id`);

    // Pre-load valid role keys per app to skip legacy roles fast
    const roleKeysByApp = new Map<string, Set<string>>();
    for (const app of apps) {
      const { rows } = await pool.query<{ key: string }>(
        `SELECT key FROM rbac.roles WHERE app_id = $1`,
        [app.id],
      );
      roleKeysByApp.set(app.id, new Set(rows.map((r) => r.key)));
    }

    for (const app of apps) {
      report.apps_scanned++;
      if (!app.zitadel_org_id) {
        report.apps_skipped_no_project++;
        console.log(`SKIP ${app.slug} — zitadel_org_id missing`);
        continue;
      }
      const validRoles = roleKeysByApp.get(app.id) ?? new Set<string>();

      console.log(`\n=== ${app.slug} (${app.zitadel_project_id}) ===`);
      let grants;
      try {
        grants = await listGrantsForProject(app.zitadel_project_id, app.zitadel_org_id);
      } catch (err) {
        report.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ERROR listing grants: ${msg}`);
        continue;
      }
      console.log(`  ${grants.length} grants từ Zitadel`);

      for (const g of grants) {
        for (const roleKey of g.roleKeys) {
          report.grants_processed++;
          if (!validRoles.has(roleKey)) {
            report.skipped_no_role++;
            console.log(`  SKIP ${g.userId} → ${roleKey} (role không có trong rbac.roles)`);
            continue;
          }

          if (dryRun) {
            const { rows: exists } = await pool.query<{ exists: boolean }>(
              `SELECT EXISTS (
                 SELECT 1 FROM rbac.user_grants
                  WHERE user_sub = $1 AND app_id = $2 AND role_key = $3 AND tenant_id IS NULL
               ) AS exists`,
              [g.userId, app.id, roleKey],
            );
            if (exists[0]?.exists) {
              report.skipped_conflict++;
              console.log(`  DRY EXISTS ${g.userId} → ${roleKey}`);
            } else {
              report.rows_inserted++;
              console.log(`  DRY INSERT ${g.userId} → ${roleKey}`);
            }
          } else {
            const res = await pool.query(
              `INSERT INTO rbac.user_grants (user_sub, app_id, role_key, tenant_id, granted_by_sub)
               SELECT $1, $2, $3, NULL, 'backfill'
               WHERE NOT EXISTS (
                 SELECT 1 FROM rbac.user_grants
                  WHERE user_sub = $1 AND app_id = $2 AND role_key = $3 AND tenant_id IS NULL
               )`,
              [g.userId, app.id, roleKey],
            );
            if ((res.rowCount ?? 0) > 0) {
              report.rows_inserted++;
              console.log(`  INSERT ${g.userId} → ${roleKey}`);
            } else {
              report.skipped_conflict++;
            }
          }
        }
      }
    }

    console.log('\n=== REPORT ===');
    console.log(JSON.stringify(report, null, 2));
    if (dryRun) {
      console.log('\n[DRY RUN] No writes performed. Re-run with --apply to persist.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
