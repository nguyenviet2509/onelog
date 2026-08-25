/**
 * hooks/use-assignments-query.ts — React Query hooks for assignments mutations.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createAssignment, deleteAssignment } from '@/api/assignments';
import { toastSuccess, toastError } from '@/lib/toast-bus';
import type { AxiosError } from 'axios';
import type { ApiError } from '@/lib/types';

export function useGrantMutation(userId: string, userEmail: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ role_key }: { role_key: string }) =>
      createAssignment(userId, role_key),
    onSuccess: () => {
      toastSuccess(`Đã cấp quyền cho ${userEmail}`);
      void qc.invalidateQueries({ queryKey: ['user-detail', userId] });
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
    mutationFn: ({ grant_id, role_key }: { grant_id: string; role_key?: string }) =>
      deleteAssignment(grant_id, userId, role_key),
    onSuccess: () => {
      toastSuccess(`Đã thu hồi quyền của ${userEmail}`);
      void qc.invalidateQueries({ queryKey: ['user-detail', userId] });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: AxiosError<ApiError>) => {
      const msg = err.response?.data?.error ?? 'Lỗi khi thu hồi quyền';
      toastError(msg);
    },
  });
}
