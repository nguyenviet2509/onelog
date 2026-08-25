/**
 * auth/oidc-client.ts — OIDC UserManager config for Zitadel PKCE flow.
 * All params read from import.meta.env — never hardcode.
 *
 * H1 fix: derive post_logout_redirect_uri and silent_redirect_uri using URL constructor
 * instead of fragile string.replace('/callback', ...) which breaks if the base URL
 * contains '/callback' elsewhere (e.g. /app/callback).
 */
import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

const authority = import.meta.env.VITE_ZITADEL_ISSUER as string;
const client_id = import.meta.env.VITE_ZITADEL_CLIENT_ID as string;
const redirect_uri = import.meta.env.VITE_ZITADEL_REDIRECT_URI as string;

if (!authority || !client_id || !redirect_uri) {
  // Warn at module load — app will fail at login time with clear message.
  console.warn('[oidc] Missing required env vars: VITE_ZITADEL_ISSUER / VITE_ZITADEL_CLIENT_ID / VITE_ZITADEL_REDIRECT_URI');
}

/** Safely derive origin-relative URI. Falls back to redirect_uri on parse error. */
function deriveUri(base: string, pathname: string): string {
  try {
    const u = new URL(base);
    u.pathname = pathname;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    // base is not a valid URL (e.g. empty during SSR/test) — return as-is
    return base;
  }
}

const post_logout_redirect_uri = deriveUri(redirect_uri, '/');
const silent_redirect_uri = import.meta.env.VITE_ZITADEL_SILENT_RENEW_URI as string | undefined
  ?? deriveUri(redirect_uri, '/silent-renew');

export const userManager = new UserManager({
  authority,
  client_id,
  redirect_uri,
  post_logout_redirect_uri,
  response_type: 'code',
  scope: 'openid profile email',
  // PKCE is default with code flow in oidc-client-ts
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  // Silent renew via iframe — accepted trade-off on HTTP review mode
  automaticSilentRenew: true,
  silent_redirect_uri,
});
