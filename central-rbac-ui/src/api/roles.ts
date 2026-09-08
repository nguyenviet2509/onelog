/**
 * api/roles.ts — Role list + create for /roles page.
 * GET /v1/roles — returns { data: Role[] }
 * POST /v1/roles — creates role via outbox → Zitadel
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
