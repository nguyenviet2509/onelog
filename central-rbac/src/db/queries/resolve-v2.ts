/**
 * queries/resolve-v2.ts — v2 resolve (user, app_slug, tenant_id) → permissions + roles + epoch.
 *
 * Phase 09 (plan 260910-1334). Fork resolve.ts với 3 khác biệt:
 *   1. Tenant filter: WHERE (tenant_id IS NULL OR tenant_id = $requested)
 *      → union global grants + tenant-scoped grants
 *   2. Fetch trực tiếp từ rbac.user_grants (Central là source of truth, Migration 019)
 *   3. Return per-app epoch từ rbac.apps.permission_epoch để SDK biết cache version
 *
 * Recursive CTE hierarchy expand reuse identical pattern từ resolve.ts (depth cap 10).
 * Excludes deprecated permissions (deprecated_at IS NOT NULL).
 */
import type { Pool } from 'pg';

export interface ResolveV2Result {
  effective_roles: string[];
  permissions: string[];
  epoch: number;
}

/**
 * Resolve permissions cho (user_sub, app_slug, tenant_id?).
 *
 * @param tenantId `null` = global-only resolution (giữ nguyên semantic v1).
 *                 String = union global grants + grants scoped to this tenant.
 *
 * Returns empty permissions/roles nếu user không có grant nào trong app.
 * Epoch luôn trả về (>= 1 cho existing app, thrown nếu app không tồn tại).
 */
export async function resolvePermissionsV2(
  pool: Pool,
  userSub: string,
  appSlug: string,
  tenantId: string | null,
): Promise<ResolveV2Result> {
  // Fetch app_id + epoch (1 query để short-circuit khi app không tồn tại)
  const appRes = await pool.query<{ id: string; permission_epoch: string }>(
    `SELECT id, permission_epoch::text AS permission_epoch
       FROM rbac.apps
      WHERE slug = $1`,
    [appSlug],
  );
  if (appRes.rows.length === 0) {
    throw new Error(`App not found: ${appSlug}`);
  }
  const app = appRes.rows[0]!;
  const appId = app.id;
  const epoch = parseInt(app.permission_epoch, 10);

  // Fetch user's role_keys trong app (tenant filter — union global + tenant-scoped)
  const grantsRes = await pool.query<{ role_key: string }>(
    `SELECT DISTINCT role_key
       FROM rbac.user_grants
      WHERE user_sub = $1
        AND app_id = $2
        AND (tenant_id IS NULL OR tenant_id = $3)`,
    [userSub, appId, tenantId],
  );
  const roleKeys = grantsRes.rows.map((r) => r.role_key);

  if (roleKeys.length === 0) {
    return { effective_roles: [], permissions: [], epoch };
  }

  // Expand hierarchy + join permissions (skip deprecated)
  const permsRes = await pool.query<{ permission_key: string; role_key: string }>(
    `WITH RECURSIVE role_tree AS (
       SELECT key, parent_key, 0 AS depth
       FROM rbac.roles
       WHERE key = ANY($1::text[])

       UNION ALL

       SELECT r.key, r.parent_key, rt.depth + 1
       FROM rbac.roles r
       JOIN role_tree rt ON r.key = rt.parent_key
       WHERE rt.depth < 10
         AND rt.parent_key IS NOT NULL
     )
     SELECT DISTINCT rp.permission_key, rt.key AS role_key
       FROM role_tree rt
       JOIN rbac.role_permissions rp ON rp.role_key = rt.key
       JOIN rbac.permissions p ON p.key = rp.permission_key
      WHERE p.deprecated_at IS NULL`,
    [roleKeys],
  );

  const permissions = [...new Set(permsRes.rows.map((r) => r.permission_key))].sort();
  const effective_roles = [...new Set(permsRes.rows.map((r) => r.role_key))].sort();

  return { effective_roles, permissions, epoch };
}

/**
 * Fetch per-app epoch cho /v2/epoch/:app_slug endpoint.
 * Returns null nếu app không tồn tại.
 */
export async function getAppEpoch(pool: Pool, appSlug: string): Promise<number | null> {
  const res = await pool.query<{ permission_epoch: string }>(
    `SELECT permission_epoch::text AS permission_epoch FROM rbac.apps WHERE slug = $1`,
    [appSlug],
  );
  if (res.rows.length === 0) return null;
  return parseInt(res.rows[0]!.permission_epoch, 10);
}

/**
 * Verify user có ít nhất 1 grant trong app (bất kể tenant).
 * Dùng cho inline scope check trong /v2/resolve route handler để chống enum user cross-app.
 */
export async function userHasGrantInApp(
  pool: Pool,
  userSub: string,
  appSlug: string,
): Promise<boolean> {
  const res = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM rbac.user_grants ug
       JOIN rbac.apps a ON a.id = ug.app_id
       WHERE ug.user_sub = $1 AND a.slug = $2
     ) AS exists`,
    [userSub, appSlug],
  );
  return res.rows[0]?.exists === true;
}
