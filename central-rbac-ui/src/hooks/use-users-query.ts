/**
 * hooks/use-users-query.ts — React Query hooks for user list + user detail.
 */
import { useQuery } from '@tanstack/react-query';
import { listUsers, getUserDetail } from '@/api/users';

export function useUsersQuery(search: string) {
  return useQuery({
    queryKey: ['users', search],
    queryFn: () => listUsers(search),
    staleTime: 30_000,
  });
}

export function useUserDetailQuery(id: string | null) {
  return useQuery({
    queryKey: ['user-detail', id],
    queryFn: () => getUserDetail(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}
