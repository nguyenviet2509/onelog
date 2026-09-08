/**
 * api/roles.ts — Role CRUD + permissions management for /roles page.
 * GET    /v1/roles                           — returns { data: Role[] }
 * POST   /v1/roles                           — create via outbox → Zitadel
 * GET    /v1/roles/:key                      — role detail (no permissions embedded)
 * GET    /v1/roles/:key/permissions          — returns { data: string[] } (permission keys)
 * PATCH  /v1/roles/:key                      — update description/parent_key
 * DELETE /v1/roles/:key                      — delete via outbox → Zitadel
 * POST   /v1/roles/:key/permissions          — attach permission { permission_key }
 * DELETE /v1/roles/:key/permissions/:permKey — detach permission
 *
 * Note: backend listRoles SQL does not yet SELECT `source` (pending migration update);
 * FE defaults missing source → 'manual' to stay backward-compat.
 */
import { apiClient } from './client';
import type { Role } from '@/lib/types';

export interface CreateRoleInput {
  key: string;
  description?: string;
  app_id: string;
  parent_key?: string | null;
}

export interface UpdateRoleInput {
  description?: string;
  parent_key?: string | null;
}

export async function listRoles(): Promise<Role[]> {
  const res = await apiClient.get<{ data: Role[] }>('/roles');
  // Normalise: ensure source field defaults to 'manual' if backend omits it
  return (res.data.data ?? []).map((r) => ({
    ...r,
    source: r.source ?? 'manual',
  }));
}

export async function createRole(input: CreateRoleInput): Promise<Role> {
  const res = await apiClient.post<Role>('/roles', input);
  return { ...res.data, source: res.data.source ?? 'manual' };
}

export async function getRoleDetail(key: string): Promise<Role> {
  const res = await apiClient.get<Role>(`/roles/${encodeURIComponent(key)}`);
  return { ...res.data, source: res.data.source ?? 'manual' };
}

/** Returns list of permission keys currently assigned to the role. */
export async function getRolePermissions(key: string): Promise<string[]> {
  const res = await apiClient.get<{ data: string[] }>(
    `/roles/${encodeURIComponent(key)}/permissions`,
  );
  return res.data.data ?? [];
}

export async function updateRole(key: string, input: UpdateRoleInput): Promise<Role> {
  const res = await apiClient.patch<Role>(`/roles/${encodeURIComponent(key)}`, input);
  return { ...res.data, source: res.data.source ?? 'manual' };
}

export async function deleteRole(key: string): Promise<void> {
  await apiClient.delete(`/roles/${encodeURIComponent(key)}`);
}

export async function attachPermission(roleKey: string, permKey: string): Promise<void> {
  await apiClient.post(`/roles/${encodeURIComponent(roleKey)}/permissions`, {
    permission_key: permKey,
  });
}

export async function detachPermission(roleKey: string, permKey: string): Promise<void> {
  await apiClient.delete(
    `/roles/${encodeURIComponent(roleKey)}/permissions/${encodeURIComponent(permKey)}`,
  );
}
