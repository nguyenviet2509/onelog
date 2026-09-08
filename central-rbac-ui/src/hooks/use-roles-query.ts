/**
 * hooks/use-roles-query.ts — TanStack Query hooks for roles CRUD.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRole, listRoles, type CreateRoleInput } from '@/api/roles';

export const ROLES_KEY = ['roles'] as const;

export function useRolesQuery() {
  return useQuery({
    queryKey: ROLES_KEY,
    queryFn: listRoles,
    staleTime: 30_000,
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
