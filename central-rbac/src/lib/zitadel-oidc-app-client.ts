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
import { mgmtPost, mgmtGet, mgmtPut } from './zitadel-http.js';
import { ZitadelHttpError } from './zitadel-http-error.js';
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

// ── Retrofit / self-heal ─────────────────────────────────────────────────────
//
// The wizard path (addOidcApp above) is correct — it sets the 3 assertion flags
// on creation. The gap this section closes: OIDC apps created BEFORE the wizard
// existed (e.g. the central-rbac OIDC client bootstrapped by hand in Zitadel
// Console). Those apps often lack `idTokenUserinfoAssertion`, which is why
// the admin UI fell back to "User 798148" instead of the display name in the
// 2026-08-27 debug session.

interface OidcAppSummary {
  id: string;
  name: string;
  oidcConfig?: OidcConfig;
}

interface OidcConfig {
  redirectUris?: string[];
  responseTypes?: string[];
  grantTypes?: string[];
  appType?: string;
  authMethodType?: string;
  postLogoutRedirectUris?: string[];
  version?: string;
  devMode?: boolean;
  accessTokenType?: string;
  accessTokenRoleAssertion?: boolean;
  idTokenRoleAssertion?: boolean;
  idTokenUserinfoAssertion?: boolean;
  clockSkew?: string;
  additionalOrigins?: string[];
}

/**
 * List OIDC apps in a Zitadel project. Non-OIDC apps (API, SAML) omitted.
 * Uses the project-scoped apps _search endpoint; org context inferred from
 * caller-supplied orgId so we can retrofit apps outside our SA default org.
 */
export async function listOidcApps(
  projectId: string,
  targetOrgId: string,
): Promise<OidcAppSummary[]> {
  const res = await mgmtPost(
    `/management/v1/projects/${encodeURIComponent(projectId)}/apps/_search`,
    targetOrgId,
    { query: { offset: '0', limit: 100 } },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ZitadelHttpError(res.status, `Zitadel listOidcApps error: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const parsed = (await res.json()) as { result?: Array<{ id: string; name: string; oidcConfig?: OidcConfig }> };
  return (parsed.result ?? [])
    .filter((a) => !!a.oidcConfig)
    .map((a) => ({ id: a.id, name: a.name, oidcConfig: a.oidcConfig }));
}

/** GET current OIDC config for a specific app — needed to preserve fields we do not want to change. */
export async function getOidcAppConfig(
  projectId: string,
  appId: string,
  targetOrgId: string,
): Promise<OidcConfig | null> {
  const res = await mgmtGet(
    `/management/v1/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appId)}`,
    targetOrgId,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ZitadelHttpError(res.status, `Zitadel getOidcApp error: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const parsed = (await res.json()) as { app?: { oidcConfig?: OidcConfig } };
  return parsed.app?.oidcConfig ?? null;
}

/**
 * PUT full OIDC config — Zitadel replaces the whole config, so caller must
 * merge on top of current state (see ensureAssertionFlags). Returns true if
 * Zitadel accepted the update.
 */
export async function putOidcAppConfig(
  projectId: string,
  appId: string,
  targetOrgId: string,
  cfg: OidcConfig,
): Promise<void> {
  const res = await mgmtPut(
    `/management/v1/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appId)}/oidc_config`,
    targetOrgId,
    cfg,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ZitadelHttpError(res.status, `Zitadel putOidcAppConfig error: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

export interface EnsureAssertionResult {
  projectId: string;
  updated: Array<{ appId: string; name: string; changedFlags: string[] }>;
  skipped: Array<{ appId: string; name: string; reason: string }>;
}

/**
 * Ensure `accessTokenRoleAssertion`, `idTokenRoleAssertion`, `idTokenUserinfoAssertion`
 * are all true on every OIDC app in a project. Reads current config first so
 * we can PUT back untouched fields (Zitadel PUT semantics = full replace).
 *
 * Idempotent: apps already having all 3 flags true are recorded under `skipped`
 * with `reason: 'already-ok'`. Safe to invoke on every boot.
 */
export async function ensureAssertionFlags(
  projectId: string,
  targetOrgId?: string,
): Promise<EnsureAssertionResult> {
  const orgIdRes = targetOrgId ?? config.ZITADEL_ORG_ID;
  if (!orgIdRes) {
    throw new Error('ensureAssertionFlags: ZITADEL_ORG_ID not configured and no override supplied');
  }

  const result: EnsureAssertionResult = { projectId, updated: [], skipped: [] };
  const apps = await listOidcApps(projectId, orgIdRes);
  for (const app of apps) {
    // listOidcApps filters non-OIDC entries — oidcConfig is guaranteed present here.
    const cur = app.oidcConfig!;

    const changedFlags: string[] = [];
    const patched: OidcConfig = { ...cur };
    if (cur.accessTokenRoleAssertion !== true) { patched.accessTokenRoleAssertion = true; changedFlags.push('accessTokenRoleAssertion'); }
    if (cur.idTokenRoleAssertion !== true) { patched.idTokenRoleAssertion = true; changedFlags.push('idTokenRoleAssertion'); }
    if (cur.idTokenUserinfoAssertion !== true) { patched.idTokenUserinfoAssertion = true; changedFlags.push('idTokenUserinfoAssertion'); }

    if (changedFlags.length === 0) {
      result.skipped.push({ appId: app.id, name: app.name, reason: 'already-ok' });
      continue;
    }

    await putOidcAppConfig(projectId, app.id, orgIdRes, patched);
    result.updated.push({ appId: app.id, name: app.name, changedFlags });
    logger.info(
      { project_id: projectId, app_id: app.id, name: app.name, flags: changedFlags },
      'zitadel-oidc-app: assertion flags patched',
    );
  }
  return result;
}
