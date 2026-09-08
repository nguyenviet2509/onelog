/**
 * api/permissions.ts — Permissions list endpoint.
 * GET /v1/permissions — returns { data: Permission[] }
 * No server-side prefix filter (BE returns all); client-side filter applied in hook.
 */
import { apiClient } from './client';

export interface Permission {
  key: string;
  description: string | null;
  deprecated?: boolean;
}

export async function listPermissions(): Promise<Permission[]> {
  const res = await apiClient.get<{ data: Permission[] }>('/permissions');
  return res.data.data ?? [];
}
