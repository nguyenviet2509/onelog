/**
 * zitadel-oidc-app-client.ts — Zitadel Mgmt API wrapper for OIDC app creation.
 * Phase 07 Admin Wizard.
 *
 * Endpoint: POST /management/v1/projects/{projectId}/apps/oidc → AddOIDCApp
 *
 * Sane defaults per plan (validation session):
 *   - grantTypes: [AUTHORIZATION_CODE, REFRESH_TOKEN]
 *   - responseTypes: [CODE]
 *   - authMethodType: BASIC (client_secret, not PKCE-only)
 *   - accessTokenType: JWT
 *   - accessTokenLifetime: 1h
 *   - refreshTokenIdleExpiration: 30d
 *   - devMode: false (production-ready HTTPS enforcement)
 */
import { config } from '../config.js';
import { mgmtPost } from './zitadel-http.js';
import { logger } from './logger.js';

export interface OidcAppCreateInput {
  projectId: string;
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
}

export interface OidcAppCreateResult {
  appId: string;
  clientId: string;
  clientSecret: string;   // shown ONCE — never persisted server-side
}

function orgId(): string {
  const o = config.ZITADEL_ORG_ID;
  if (!o) throw new Error('ZITADEL_ORG_ID not configured');
  return o;
}

/**
 * Add OIDC app to a project. Returns clientId + clientSecret (shown ONCE per Fix UX).
 * Throws on any non-2xx from Zitadel; caller responsible for rollback (RemoveProject).
 */
export async function addOidcApp(input: OidcAppCreateInput): Promise<OidcAppCreateResult> {
  const body = {
    name: input.name,
    redirectUris: input.redirectUris,
    responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
    grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
    appType: 'OIDC_APP_TYPE_WEB',
    authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
    postLogoutRedirectUris: input.postLogoutRedirectUris ?? [],
    version: 'OIDC_VERSION_1_0',
    devMode: false,
    accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
    accessTokenRoleAssertion: true,
    idTokenRoleAssertion: true,
    idTokenUserinfoAssertion: true,
    // Lifetimes — Zitadel accepts protobuf Duration strings
    clockSkew: '1s',
  };

  const res = await mgmtPost(
    `/management/v1/projects/${input.projectId}/apps/oidc`,
    orgId(),
    body,
  );

  if (res.status !== 200 && res.status !== 201) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Zitadel AddOIDCApp failed ${res.status}: ${errBody}`);
  }

  const parsed = (await res.json()) as {
    appId: string;
    clientId: string;
    clientSecret: string;
  };

  logger.info(
    { project_id: input.projectId, app_id: parsed.appId, client_id: parsed.clientId },
    'zitadel-oidc-app: created',
  );

  return {
    appId: parsed.appId,
    clientId: parsed.clientId,
    clientSecret: parsed.clientSecret,
  };
}
