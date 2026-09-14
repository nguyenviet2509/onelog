/**
 * lib/expand-role-hierarchy.ts — Walk parent_key chain cho set of role_keys.
 * Phase 09 (plan 260910-1334).
 *
 * Used by:
 *   - Delegation check (services/delegation-check.ts) — expand grantor's roles để compare can_grant
 *   - Outbox worker (services/outbox-processor.ts) — expand grant list trước Zitadel PUT
 *
 * V1 backward-compat guard: nếu role.parent_key IS NULL → expand = self only.
 * Chỉ V2 roles (wizard/manifest set parent_key) mới trigger hierarchy expand.
 * Không guard này = existing v1 grants sẽ được re-synced expanded → Zitadel Console surprise.
 *
 * Depth cap 10 khớp với migration 019 cycle detection trigger.
 */
import type { Pool, PoolClient } from 'pg';

const MAX_DEPTH = 10;

/**
 * Expand role hierarchy: cho set role_keys, trả về SORTED UNIQUE list of self + ancestors.
 *
 * SQL recursive CTE (same pattern as resolve.ts):
 *   Base: input role_keys
 *   Recursive: walk parent chain, cap depth 10
 *
 * V1 guard: nếu tất cả input roles có parent_key=NULL → return input sorted (no expand).
 */
export async function expandRoleHierarchy(
  pool: Pool | PoolClient,
  roleKeys: string[],
): Promise<string[]> {
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
       WHERE rt.depth < $2
         AND rt.parent_key IS NOT NULL
     )
     SELECT DISTINCT key FROM role_tree ORDER BY key ASC`,
    [roleKeys, MAX_DEPTH],
  );

  return res.rows.map((r) => r.key);
}

/**
 * Expand hierarchy CHỈ nếu ít nhất 1 role có parent_key non-null.
 * V1 backward-compat: nếu MỌI role có parent_key=NULL → return input sorted (no expand).
 * Dùng bởi outbox worker để KHÔNG re-sync v1 grants với expanded list.
 */
export async function expandRoleHierarchyV1Safe(
  pool: Pool | PoolClient,
  roleKeys: string[],
): Promise<string[]> {
  if (roleKeys.length === 0) return [];

  // Check nếu bất kỳ role nào có parent_key non-null
  const parentCheck = await pool.query<{ has_parent: boolean }>(
    `SELECT bool_or(parent_key IS NOT NULL) AS has_parent
       FROM rbac.roles
      WHERE key = ANY($1::text[])`,
    [roleKeys],
  );

  const hasParent = parentCheck.rows[0]?.has_parent === true;
  if (!hasParent) {
    // V1 guard: no hierarchy → self only, no expand
    return [...roleKeys].sort();
  }

  return expandRoleHierarchy(pool, roleKeys);
}
