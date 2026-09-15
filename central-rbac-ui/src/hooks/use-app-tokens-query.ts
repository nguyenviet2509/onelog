/**
 * hooks/use-app-tokens-query.ts — React Query hooks for per-app token CRUD.
 *
 * Backed by admin API at /v1/admin/apps/:slug/tokens (Phase 3).
 * Create returns one-time reveal of plaintext token — surface in modal, never re-fetch.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createAppToken, listAppTokens, revokeAppToken } from '@/api/apps';

const TOKENS_KEY = (slug: string) => ['apps', slug, 'tokens'] as const;

export function useAppTokensQuery(slug: string | undefined) {
  return useQuery({
    queryKey: TOKENS_KEY(slug ?? ''),
    queryFn: () => listAppTokens(slug!),
    enabled: !!slug,
    staleTime: 10_000,
  });
}

export function useCreateAppTokenMutation(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => createAppToken(slug, label),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TOKENS_KEY(slug) });
    },
  });
}

export function useRevokeAppTokenMutation(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => revokeAppToken(slug, tokenId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TOKENS_KEY(slug) });
    },
  });
}
