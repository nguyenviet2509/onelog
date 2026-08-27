/**
 * api/users.ts — User list + detail endpoints.
 * GET /v1/users?q=&limit= — list with aggregated grant_count
 * GET /v1/users/:id       — user detail + grants array
 */
import { apiClient } from './client';
import type { UserDetail, ZitadelUser } from '@/lib/types';

// Default limit = backend max (200). Pagination UI deferred — scales to
// current spike-test cohorts; revisit with cursor pagination when > 200 users.
export async function listUsers(q = '', limit = 200): Promise<ZitadelUser[]> {
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
