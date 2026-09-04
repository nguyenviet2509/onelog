/**
 * api/apps.ts — Phase 07 admin wizard + Phase 08 manifest sync endpoints.
 */
import { apiClient } from './client';

export interface App {
  /** null when the Zitadel project is not registered in rbac.apps yet */
  id: string | null;
  slug: string | null;
  name: string;
  zitadel_project_id: string | null;
  zitadel_client_id: string | null;
  zitadel_org_id: string | null;
  org_name: string | null;
  manifest_url: string | null;
  created_at: string | null;
  created_by: string | null;
  /** false when the row is an unregistered Zitadel project surfaced for visibility */
  registered: boolean;
}

export interface CreateAppInput {
  name: string;
  slug: string;
  callback_urls: string[];
  manifest_url?: string;
}

export interface CreateAppResult {
  id: string;
  slug: string;
  name: string;
  zitadel_project_id: string;
  client_id: string;
  client_secret: string;   // ONE-TIME reveal
  warning: string;
}

export type DiffAction = 'add' | 'update-desc' | 'explicit-deprecate' | 'implicit-deprecate';

export interface DiffItem {
  action: DiffAction;
  id: string;
  current?: { description: string; deprecated_at: string | null; alias_of: string | null };
  incoming?: { description: string; status: 'active' | 'soft-deleted'; alias_of?: string };
}

export interface SyncResult {
  status: 'fetched' | 'not-modified';
  etag: string | null;
  manifest_sha256?: string;
  service?: string;
  version?: string;
  diff?: {
    items: DiffItem[];
    counts: Record<DiffAction, number>;
  };
}

export interface ApplyResult {
  status: 'applied';
  applied_counts: Record<DiffAction, number>;
}

export async function listApps(): Promise<App[]> {
  const res = await apiClient.get<{ apps: App[] }>('/admin/apps');
  return res.data.apps;
}

export async function createApp(input: CreateAppInput): Promise<CreateAppResult> {
  const res = await apiClient.post<CreateAppResult>('/admin/apps', input);
  return res.data;
}

export async function syncManifest(appId: string): Promise<SyncResult> {
  const res = await apiClient.post<SyncResult>(`/admin/apps/${appId}/sync-manifest`);
  return res.data;
}

export async function applyManifestDiff(
  appId: string,
  manifest_sha256: string,
  approved_items: Array<{ action: DiffAction; id: string }>,
): Promise<ApplyResult> {
  const res = await apiClient.post<ApplyResult>(`/admin/apps/${appId}/apply-manifest-diff`, {
    manifest_sha256,
    approved_items,
  });
  return res.data;
}

export async function updateManifestUrl(appId: string, manifestUrl: string): Promise<void> {
  await apiClient.patch(`/admin/apps/${appId}/manifest-url`, { manifest_url: manifestUrl });
}

export async function deleteApp(appId: string): Promise<void> {
  await apiClient.delete(`/admin/apps/${appId}`);
}
