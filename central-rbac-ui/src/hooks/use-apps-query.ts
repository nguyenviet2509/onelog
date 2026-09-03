/**
 * hooks/use-apps-query.ts — React Query hooks for apps registry + wizard flow.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyManifestDiff,
  createApp,
  deleteApp,
  listApps,
  syncManifest,
  updateManifestUrl,
  type CreateAppInput,
  type DiffAction,
} from '@/api/apps';

const APPS_KEY = ['apps'] as const;

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
