/**
 * auth/auth-context.tsx — Wraps react-oidc-context AuthProvider with Zitadel userManager.
 * Exposes useAuth hook re-exported from react-oidc-context for convenience.
 */
import type { ReactNode } from 'react';
import { AuthProvider } from 'react-oidc-context';
import { userManager } from './oidc-client';

interface Props {
  children: ReactNode;
}

export function OidcAuthProvider({ children }: Props) {
  return (
    <AuthProvider userManager={userManager}>
      {children}
    </AuthProvider>
  );
}

// Re-export for single import point throughout the app
export { useAuth } from 'react-oidc-context';
