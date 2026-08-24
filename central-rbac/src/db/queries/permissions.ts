/**
 * queries/permissions.ts — Parameterized SQL for permissions CRUD.
 * All queries use $N placeholders — no string interpolation.
 */
import type { Pool, PoolClient } from 'pg';

export interface Permission {
  id: string;
  key: string;
  description: string;
  alias_of: string | null;
  deprecated: boolean;
  created_at: string;
  updated_at: string;
}

export async function listPermissions(pool: Pool): Promise<Permission[]> {
  const res = await pool.query<Permission>(
    `SELECT id, key, description, alias_of, deprecated, created_at, updated_at
     FROM rbac.permissions
     ORDER BY key ASC`,
  );
  return res.rows;
}

export async function getPermissionByKey(pool: Pool, key: string): Promise<Permission | null> {
  const res = await pool.query<Permission>(
    `SELECT id, key, description, alias_of, deprecated, created_at, updated_at
     FROM rbac.permissions WHERE key = $1`,
    [key],
  );
  return res.rows[0] ?? null;
}

export interface CreatePermissionInput {
  key: string;
  description?: string;
  alias_of?: string | null;
}

export async function createPermission(
  pool: Pool | PoolClient,
  input: CreatePermissionInput,
): Promise<Permission> {
  const res = await pool.query<Permission>(
    `INSERT INTO rbac.permissions (key, description, alias_of)
     VALUES ($1, $2, $3)
     RETURNING id, key, description, alias_of, deprecated, created_at, updated_at`,
    [input.key, input.description ?? '', input.alias_of ?? null],
  );
  // Non-null: INSERT always returns a row or throws
  return res.rows[0]!;
}

export interface UpdatePermissionInput {
  description?: string;
  alias_of?: string | null;
  deprecated?: boolean;
}

export async function updatePermission(
  pool: Pool | PoolClient,
  key: string,
  input: UpdatePermissionInput,
): Promise<Permission | null> {
  // key is immutable — only description, alias_of, deprecated can change
  const res = await pool.query<Permission>(
    `UPDATE rbac.permissions
     SET description = COALESCE($2, description),
         alias_of    = CASE WHEN $3::boolean THEN $4 ELSE alias_of END,
         deprecated  = COALESCE($5, deprecated)
     WHERE key = $1
     RETURNING id, key, description, alias_of, deprecated, created_at, updated_at`,
    [
      key,
      input.description ?? null,
      input.alias_of !== undefined,
      input.alias_of ?? null,
      input.deprecated ?? null,
    ],
  );
  return res.rows[0] ?? null;
}

export async function deletePermission(pool: Pool | PoolClient, key: string): Promise<boolean> {
  const res = await pool.query(`DELETE FROM rbac.permissions WHERE key = $1`, [key]);
  return (res.rowCount ?? 0) > 0;
}

export async function getPermissionStats(
  pool: Pool,
  key: string,
): Promise<{ role_count: number } | null> {
  const exists = await getPermissionByKey(pool, key);
  if (!exists) return null;
  const res = await pool.query<{ role_count: string }>(
    `SELECT COUNT(*) AS role_count FROM rbac.role_permissions WHERE permission_key = $1`,
    [key],
  );
  return { role_count: parseInt(res.rows[0]?.role_count ?? '0', 10) };
}
