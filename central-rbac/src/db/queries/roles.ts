/**
 * queries/roles.ts — Parameterized SQL for roles CRUD + role_permissions.
 */
import type { Pool, PoolClient } from 'pg';

export interface Role {
  id: string;
  key: string;
  description: string;
  parent_key: string | null;
  created_at: string;
  updated_at: string;
}

export async function listRoles(pool: Pool): Promise<Role[]> {
  const res = await pool.query<Role>(
    `SELECT id, key, description, parent_key, created_at, updated_at
     FROM rbac.roles ORDER BY key ASC`,
  );
  return res.rows;
}

export async function getRoleByKey(pool: Pool, key: string): Promise<Role | null> {
  const res = await pool.query<Role>(
    `SELECT id, key, description, parent_key, created_at, updated_at
     FROM rbac.roles WHERE key = $1`,
    [key],
  );
  return res.rows[0] ?? null;
}

export interface CreateRoleInput {
  key: string;
  description?: string;
  parent_key?: string | null;
}

export async function createRole(pool: Pool | PoolClient, input: CreateRoleInput): Promise<Role> {
  const res = await pool.query<Role>(
    `INSERT INTO rbac.roles (key, description, parent_key)
     VALUES ($1, $2, $3)
     RETURNING id, key, description, parent_key, created_at, updated_at`,
    [input.key, input.description ?? '', input.parent_key ?? null],
  );
  return res.rows[0]!;
}

export interface UpdateRoleInput {
  description?: string;
  parent_key?: string | null;
}

export async function updateRole(
  pool: Pool | PoolClient,
  key: string,
  input: UpdateRoleInput,
): Promise<Role | null> {
  const res = await pool.query<Role>(
    `UPDATE rbac.roles
     SET description = COALESCE($2, description),
         parent_key  = CASE WHEN $3::boolean THEN $4 ELSE parent_key END
     WHERE key = $1
     RETURNING id, key, description, parent_key, created_at, updated_at`,
    [key, input.description ?? null, input.parent_key !== undefined, input.parent_key ?? null],
  );
  return res.rows[0] ?? null;
}

export async function deleteRole(pool: Pool | PoolClient, key: string): Promise<boolean> {
  const res = await pool.query(`DELETE FROM rbac.roles WHERE key = $1`, [key]);
  return (res.rowCount ?? 0) > 0;
}

export async function getRolePermissions(pool: Pool, roleKey: string): Promise<string[]> {
  const res = await pool.query<{ permission_key: string }>(
    `SELECT permission_key FROM rbac.role_permissions WHERE role_key = $1 ORDER BY permission_key`,
    [roleKey],
  );
  return res.rows.map((r) => r.permission_key);
}

export async function addRolePermission(
  pool: Pool | PoolClient,
  roleKey: string,
  permissionKey: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO rbac.role_permissions (role_key, permission_key)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [roleKey, permissionKey],
  );
}

export async function removeRolePermission(
  pool: Pool | PoolClient,
  roleKey: string,
  permissionKey: string,
): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM rbac.role_permissions WHERE role_key = $1 AND permission_key = $2`,
    [roleKey, permissionKey],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getAllRolesFlat(
  pool: Pool,
): Promise<Array<{ key: string; parent_key: string | null }>> {
  const res = await pool.query<{ key: string; parent_key: string | null }>(
    `SELECT key, parent_key FROM rbac.roles`,
  );
  return res.rows;
}

export async function getRoleStats(
  pool: Pool,
  key: string,
): Promise<{ permission_count_direct: number; permission_count_inherited: number } | null> {
  const role = await getRoleByKey(pool, key);
  if (!role) return null;

  const directRes = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM rbac.role_permissions WHERE role_key = $1`,
    [key],
  );
  const direct = parseInt(directRes.rows[0]?.cnt ?? '0', 10);

  // Inherited: all permissions from parent hierarchy via recursive CTE
  const inheritedRes = await pool.query<{ cnt: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT parent_key FROM rbac.roles WHERE key = $1 AND parent_key IS NOT NULL
       UNION ALL
       SELECT r.parent_key FROM rbac.roles r
       JOIN ancestors a ON r.key = a.parent_key
       WHERE r.parent_key IS NOT NULL
     )
     SELECT COUNT(DISTINCT rp.permission_key) AS cnt
     FROM rbac.role_permissions rp
     WHERE rp.role_key IN (SELECT parent_key FROM ancestors WHERE parent_key IS NOT NULL)`,
    [key],
  );
  const inherited = parseInt(inheritedRes.rows[0]?.cnt ?? '0', 10);

  return { permission_count_direct: direct, permission_count_inherited: inherited };
}
