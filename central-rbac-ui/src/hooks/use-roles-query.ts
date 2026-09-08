/**
 * hooks/use-roles-query.ts — TanStack Query hooks for roles CRUD + permissions management.
 *
 * Query keys:
 *   ['roles']                    — list all roles
 *   ['role-detail', key]         — single role detail
 *   ['role-permissions', key]    — permission keys for a role
 *   ['permissions']              — all permissions (client-side filtered per prefix)
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRole,
  listRoles,
  getRoleDetail,
  getRolePermissions,
  updateRole,
  deleteRole,
  attachPermission,
  detachPermission,
  type CreateRoleInput,
  type UpdateRoleInput,
} from '@/api/roles';
import { listPermissions } from '@/api/permissions';
import { toastSuccess, toastError } from '@/lib/toast-bus';
import type { AxiosError } from 'axios';

export const ROLES_KEY = ['roles'] as const;

export function useRolesQuery(options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: ROLES_KEY,
    queryFn: listRoles,
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval,
  });
}

export function useRoleDetailQuery(key: string | null) {
  return useQuery({
    queryKey: ['role-detail', key],
    queryFn: () => getRoleDetail(key!),
    enabled: !!key,
    staleTime: 30_000,
  });
}

export function useRolePermissionsQuery(key: string | null) {
  return useQuery({
    queryKey: ['role-permissions', key],
    queryFn: () => getRolePermissions(key!),
    enabled: !!key,
    staleTime: 0, // always fresh — user just opened the drawer
  });
}

/** All permissions from BE. Client-side prefix filter applied in component. */
export function usePermissionsQuery() {
  return useQuery({
    queryKey: ['permissions'],
    queryFn: listPermissions,
    staleTime: 5 * 60_000, // 5 min — permissions rarely change
  });
}

export function useCreateRoleMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoleInput) => createRole(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ROLES_KEY });
    },
  });
}

export function useUpdateRoleMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, input }: { key: string; input: UpdateRoleInput }) =>
      updateRole(key, input),
    onSuccess: (_data, { key }) => {
      void qc.invalidateQueries({ queryKey: ROLES_KEY });
      void qc.invalidateQueries({ queryKey: ['role-detail', key] });
    },
  });
}

export function useDeleteRoleMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => deleteRole(key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ROLES_KEY });
    },
  });
}

/** Batch attach + detach permissions for a role. Computes diff from old → new. */
export function useRolePermissionsSaveMutation(roleKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      oldKeys,
      newKeys,
    }: {
      oldKeys: Set<string>;
      newKeys: Set<string>;
    }) => {
      const added = [...newKeys].filter((k) => !oldKeys.has(k));
      const removed = [...oldKeys].filter((k) => !newKeys.has(k));

      const results = await Promise.allSettled([
        ...added.map((k) => attachPermission(roleKey, k)),
        ...removed.map((k) => detachPermission(roleKey, k)),
      ]);

      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        throw new Error(`${failures.length} thao tác thất bại`);
      }

      return { added: added.length, removed: removed.length };
    },
    onSuccess: ({ added, removed }) => {
      void qc.invalidateQueries({ queryKey: ['role-permissions', roleKey] });
      void qc.invalidateQueries({ queryKey: ['role-detail', roleKey] });
      toastSuccess(`Đã lưu (+${added}, -${removed})`);
    },
    onError: (err: AxiosError | Error) => {
      const msg = 'message' in err ? err.message : 'Lỗi khi lưu permissions';
      toastError(msg);
      // Refetch to sync actual state after partial failure
      void qc.invalidateQueries({ queryKey: ['role-permissions', roleKey] });
    },
  });
}
