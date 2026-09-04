/**
 * hooks/use-assignments-query.ts — React Query hooks for assignments mutations.
 *
 * Grant/revoke enqueue via outbox → Zitadel update is async (~1-2s).
 * After mutation success we poll user-detail with fresh=1 (bypass backend Redis cache)
 * so the drawer reflects final Zitadel state as soon as the outbox worker commits.
 * fetchQuery is used (not invalidateQueries) to run our custom queryFn with fresh=1.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createAssignment, deleteAssignment } from '@/api/assignments';
import { getUserDetail } from '@/api/users';
import { toastSuccess, toastError } from '@/lib/toast-bus';
import type { AxiosError } from 'axios';
import type { ApiError } from '@/lib/types';

// Retry cadence: outbox worker commits in ~1-2s; buffer beyond that in case Zitadel
// read-after-write is eventually consistent. Total ~5s window.
const REFETCH_DELAYS_MS = [700, 1800, 3200, 5000];

function scheduleUserDetailRefetch(
  qc: ReturnType<typeof useQueryClient>,
  userId: string,
): void {
  const refetch = () =>
    qc
      .fetchQuery({
        queryKey: ['user-detail', userId],
        queryFn: () => getUserDetail(userId, true),
        staleTime: 0,
      })
      .catch(() => {});

  void refetch();
  for (const delay of REFETCH_DELAYS_MS) {
    setTimeout(refetch, delay);
  }
}

export function useGrantMutation(userId: string, userEmail: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ role_key }: { role_key: string }) =>
      createAssignment(userId, role_key),
    onSuccess: () => {
      toastSuccess(`Đã cấp quyền cho ${userEmail} (đang đồng bộ...)`);
      scheduleUserDetailRefetch(qc, userId);
      // Fire delayed users-list invalidations so the grant_count column reflects
      // the new number after Zitadel outbox commit (~1-2s). Immediate invalidate
      // would refetch stale count; wait until the drawer refetch pass completes.
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['users'] }), 2000);
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['users'] }), 5500);
    },
    onError: (err: AxiosError<ApiError>) => {
      const msg = err.response?.data?.error ?? 'Lỗi khi cấp quyền';
      toastError(msg);
    },
  });
}

export function useRevokeMutation(userId: string, userEmail: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grant_id, role_keys }: { grant_id: string; role_keys?: string[] }) =>
      deleteAssignment(grant_id, userId, role_keys),
    onSuccess: () => {
      toastSuccess(`Đã thu hồi quyền của ${userEmail} (đang đồng bộ...)`);
      scheduleUserDetailRefetch(qc, userId);
      // Same delayed invalidations as grant — count only updates after outbox commit.
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['users'] }), 2000);
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['users'] }), 5500);
    },
    onError: (err: AxiosError<ApiError>) => {
      const msg = err.response?.data?.error ?? 'Lỗi khi thu hồi quyền';
      toastError(msg);
    },
  });
}
