/**
 * hooks/use-apps-query.ts — React Query hooks for apps registry + wizard flow.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyManifestDiff,
  createApp,
  deleteApp,
  getAppOidcConfig,
  listApps,
  patchApp,
  syncManifest,
  updateManifestUrl,
  type CreateAppInput,
  type DiffAction,
  type PatchAppInput,
} from '@/api/apps';

const APPS_KEY = ['apps'] as const;
const APP_OIDC_KEY = (slug: string) => ['apps', slug, 'oidc-config'] as const;

export function useAppsQuery() {
  return useQuery({
    queryKey: APPS_KEY,
    queryFn: listApps,
    staleTime: 30_000,
  });
}

export function useCreateAppMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAppInput) => createApp(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: APPS_KEY });
    },
  });
}

export function useSyncManifestMutation(appId: string) {
  return useMutation({
    mutationFn: () => syncManifest(appId),
  });
}

export function useApplyManifestDiffMutation(appId: string) {
  return useMutation({
    mutationFn: (input: { manifest_sha256: string; approved_items: Array<{ action: DiffAction; id: string }> }) =>
      applyManifestDiff(appId, input.manifest_sha256, input.approved_items),
  });
}

export function useUpdateManifestUrlMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { appId: string; manifestUrl: string }) =>
      updateManifestUrl(input.appId, input.manifestUrl),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: APPS_KEY });
    },
  });
}

export function useDeleteAppMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (appId: string) => deleteApp(appId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: APPS_KEY });
    },
  });
}

// ── Phase 09: Edit App page ─────────────────────────────────────────────────

export function useAppOidcConfigQuery(slug: string | undefined) {
  return useQuery({
    queryKey: APP_OIDC_KEY(slug ?? ''),
    queryFn: () => getAppOidcConfig(slug!),
    enabled: !!slug,
    // No stale time — always refetch on mount so Edit page sees fresh Zitadel state
    staleTime: 0,
  });
}

export function usePatchAppMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { slug: string; body: PatchAppInput }) => patchApp(input.slug, input.body),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: APPS_KEY });
      void qc.invalidateQueries({ queryKey: APP_OIDC_KEY(vars.slug) });
    },
  });
}
