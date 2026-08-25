/**
 * pages/login/silent-renew-page.tsx — Silent renew iframe handler.
 *
 * Loaded inside a hidden iframe by oidc-client-ts when automaticSilentRenew fires.
 * Calls signinSilentCallback() to complete the token refresh handshake.
 *
 * H1 fix: /silent-renew route was missing — iframe 404'd and silent renew failed silently.
 * Renders nothing visible; the callback is the only side-effect needed.
 */
import { useEffect } from 'react';
import { userManager } from '@/auth/oidc-client';

export function SilentRenewPage() {
  useEffect(() => {
    userManager.signinSilentCallback().catch((err: unknown) => {
      // Log only — parent frame handles failure via userManager events
      console.error('[silent-renew] signinSilentCallback error:', err);
    });
  }, []);

  // Blank page — rendered only in hidden iframe
  return null;
}
