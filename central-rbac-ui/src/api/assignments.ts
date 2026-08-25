/**
 * api/assignments.ts — Assignment CRUD endpoints.
 * POST /v1/assignments              — assign role_key to user_id
 * DELETE /v1/assignments/:id        — revoke grant (requires user_id query param)
 * GET  /v1/assignments?user_id=     — list user grants (cached 60s backend-side)
 */
import { apiClient } from './client';
import type { AssignmentResponse, Grant } from '@/lib/types';

export async function createAssignment(
  user_id: string,
  role_key: string,
): Promise<AssignmentResponse> {
  const res = await apiClient.post<AssignmentResponse>('/assignments', { user_id, role_key });
  return res.data;
}

export async function deleteAssignment(
  grant_id: string,
  user_id: string,
  role_key?: string,
): Promise<void> {
  await apiClient.delete(`/assignments/${grant_id}`, {
    params: { user_id, ...(role_key ? { role_key } : {}) },
  });
}

export async function listAssignments(user_id: string, project_id?: string): Promise<Grant[]> {
  const res = await apiClient.get<{ data: Grant[] }>('/assignments', {
    params: { user_id, ...(project_id ? { project_id } : {}) },
  });
  return res.data.data;
}
