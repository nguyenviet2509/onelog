/**
 * hooks/use-user-provision-mutation.ts — React Query mutations for Phase 02
 * user lifecycle admin actions. On success, invalidates the users list so the
 * table reflects new user / state change immediately.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import {
  createUser,
  deactivateUser,
  reactivateUser,
  deleteUser,
  type CreateUserPayload,
} from '@/api/user-provision';
import { toastSuccess, toastError } from '@/lib/toast-bus';
import type { ApiError } from '@/lib/types';

function extractErr(err: AxiosError<ApiError>, fallback: string): string {
  return err.response?.data?.error ?? fallback;
}

export function useCreateUserMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateUserPayload) => createUser(payload),
    onSuccess: (data) => {
      const msg = data.already_existed
        ? `Người dùng ${data.email} đã tồn tại — tái sử dụng ID`
        : `Đã tạo người dùng ${data.email}. Email xác thực đang được gửi.`;
      toastSuccess(msg);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: AxiosError<ApiError>) => {
      toastError(extractErr(err, 'Không thể tạo người dùng'));
    },
  });
}

export function useDeactivateUserMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, orgId }: { userId: string; orgId?: string }) =>
      deactivateUser(userId, orgId),
    onSuccess: (_data, vars) => {
      toastSuccess('Đã vô hiệu hoá người dùng');
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['user-detail', vars.userId] });
    },
    onError: (err: AxiosError<ApiError>) => {
      toastError(extractErr(err, 'Không thể vô hiệu hoá người dùng'));
    },
  });
}

export function useReactivateUserMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, orgId }: { userId: string; orgId?: string }) =>
      reactivateUser(userId, orgId),
    onSuccess: (_data, vars) => {
      toastSuccess('Đã kích hoạt lại người dùng');
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['user-detail', vars.userId] });
    },
    onError: (err: AxiosError<ApiError>) => {
      toastError(extractErr(err, 'Không thể kích hoạt lại người dùng'));
    },
  });
}

export function useDeleteUserMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, orgId }: { userId: string; orgId?: string }) =>
      deleteUser(userId, orgId),
    onSuccess: (_data, vars) => {
      toastSuccess('Đã xoá người dùng');
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['user-detail', vars.userId] });
    },
    onError: (err: AxiosError<ApiError>) => {
      toastError(extractErr(err, 'Không thể xoá người dùng'));
    },
  });
}
