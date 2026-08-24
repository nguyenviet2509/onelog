/**
 * queries/resolve.ts — Recursive CTE for flattening role hierarchy permissions.
 * Depth cap 10 prevents runaway queries on circular or deep hierarchies.
 */
import type { Pool } from 'pg';

export interface ResolveResult {
  permissions: string[];
  roles_expanded: string[];
}

/**
 * Flatten permissions for a set of role keys, traversing parent hierarchy.
 * Uses recursive CTE with depth cap 10.
 */
export async function resolvePermissions(
  pool: Pool,
  roleKeys: string[],
): Promise<ResolveResult> {
  if (roleKeys.length === 0) {
    return { permissions: [], roles_expanded: [] };
  }

  const res = await pool.query<{ permission_key: string; role_key: string }>(
    `WITH RECURSIVE role_tree AS (
       -- Base: seed roles
       SELECT key, parent_key, 0 AS depth
       FROM rbac.roles
       WHERE key = ANY($1::text[])

       UNION ALL

       -- Recursive: walk up parent hierarchy, cap at depth 10
       SELECT r.key, r.parent_key, rt.depth + 1
       FROM rbac.roles r
       JOIN role_tree rt ON r.key = rt.parent_key
       WHERE rt.depth < 10
         AND rt.parent_key IS NOT NULL
     )
     SELECT DISTINCT rp.permission_key, rp.role_key
     FROM rbac.role_permissions rp
     JOIN role_tree rt ON rp.role_key = rt.key
     ORDER BY rp.permission_key ASC`,
    [roleKeys],
  );

  const permissions = [...new Set(res.rows.map((r) => r.permission_key))];
  const roles_expanded = [...new Set(res.rows.map((r) => r.role_key))];

  return { permissions, roles_expanded };
}

/**
 * Resolve expanded role keys only (no permission join) — used for stats.
 */
export async function expandRoleHierarchy(pool: Pool, roleKeys: string[]): Promise<string[]> {
  if (roleKeys.length === 0) return [];

  const res = await pool.query<{ key: string }>(
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
     SELECT DISTINCT key FROM role_tree ORDER BY key`,
    [roleKeys],
  );

  return res.rows.map((r) => r.key);
}
