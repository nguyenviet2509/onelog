/**
 * api/roles.ts — Fetch role list for grant dialog dropdown.
 * GET /v1/roles — returns { data: Role[] }
 */
import { apiClient } from './client';
import type { Role } from '@/lib/types';

export async function listRoles(): Promise<Role[]> {
  const res = await apiClient.get<{ data: Role[] }>('/roles');
  return res.data.data;
}
