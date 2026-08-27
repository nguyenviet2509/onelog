/**
 * hooks/use-me.ts — Read admin's profile from OIDC ID token claims via userManager.
 *
 * Zero backend call: claims already live in memory after login (oidc-client-ts).
 * Fallback chain for displayName: name → preferred_username → email → sub (short).
 */
import { useQuery } from '@tanstack/react-query';
import { userManager } from '@/auth/oidc-client';

export interface MeProfile {
  id: string;
  displayName: string;
  email: string;
  initial: string;
}

async function loadMe(): Promise<MeProfile | null> {
  const user = await userManager.getUser();
  if (!user) return null;
  const p = user.profile;
  const sub = p.sub ?? '';
  const displayName =
    (p.name as string | undefined) ||
    (p.preferred_username as string | undefined) ||
    p.email ||
    (sub ? `User ${sub.slice(-6)}` : 'User');
  return {
    id: sub,
    displayName,
    email: p.email ?? '',
    initial: displayName[0]?.toUpperCase() ?? '?',
  };
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: loadMe,
    staleTime: 5 * 60_000,
  });
}
