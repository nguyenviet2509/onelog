/**
 * hooks/use-user-provision-config.ts — Fetches the config the create-user dialog
 * needs: password policy (drives realtime strength checklist) + smtp_enabled
 * (drives invite_email radio availability). Cached 5min.
 */
import { useQuery } from '@tanstack/react-query';
import { getUserProvisionConfig } from '@/api/user-provision';

export function useUserProvisionConfig() {
  return useQuery({
    queryKey: ['user-provision-config'],
    queryFn: getUserProvisionConfig,
    staleTime: 5 * 60 * 1000,
  });
}
