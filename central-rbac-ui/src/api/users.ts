/**
 * api/users.ts — User list + detail endpoints.
 * GET /v1/users?q=&limit= — list with aggregated grant_count
 * GET /v1/users/:id       — user detail + grants array
 *
 * TODO(backend): /v1/users and /v1/users/:id endpoints not yet implemented in central-rbac.
 * These calls will 404 until Phase 5 backend adds user proxy routes (Zitadel user list API).
 */
import { apiClient } from './client';
import type { UserDetail, ZitadelUser } from '@/lib/types';

export async function listUsers(q = '', limit = 50): Promise<ZitadelUser[]> {
  const res = await apiClient.get<{ data: ZitadelUser[] }>('/users', {
    params: { q, limit },
  });
  return res.data.data;
}

export async function getUserDetail(id: string, fresh = false): Promise<UserDetail> {
  const res = await apiClient.get<UserDetail>(`/users/${id}`, {
    params: fresh ? { fresh: '1' } : undefined,
  });
  return res.data;
}
