/**
 * api/projects.ts — Fetch project list for grant dialog.
 * GET /v1/projects — returns { data: Project[] }
 *
 * TODO(backend): /v1/projects not yet implemented in central-rbac.
 * Falls back to hardcoded MVP project list if the endpoint returns 404.
 */
import { apiClient } from './client';
import type { Project } from '@/lib/types';

const MVP_FALLBACK: Project[] = [
  { id: 'central-rbac', name: 'Central RBAC' },
];

export async function listProjects(): Promise<Project[]> {
  try {
    const res = await apiClient.get<{ data: Project[] }>('/projects');
    return res.data.data;
  } catch (err: unknown) {
    // Graceful fallback: backend /v1/projects not yet implemented
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 404 || status === undefined) {
      return MVP_FALLBACK;
    }
    throw err;
  }
}
