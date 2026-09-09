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

/**
 * OIDC client type — user-facing category, resolved to Zitadel enums via CLIENT_TYPE_MAP.
 *   web    → confidential server-side app, client_secret issued
 *   spa    → browser SPA, PKCE required, no client_secret
 *   native → mobile/desktop app, PKCE required, no client_secret
 */
export type ClientType = 'web' | 'spa' | 'native';

/**
 * Mapping single source of truth: user-facing client_type → Zitadel enums.
 * Keeps route/handler code free of Zitadel-specific constants.
 */
export const CLIENT_TYPE_MAP: Record<ClientType, { appType: string; authMethodType: string }> = {
  web:    { appType: 'OIDC_APP_TYPE_WEB',        authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC' },
  spa:    { appType: 'OIDC_APP_TYPE_USER_AGENT', authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE'  },
  native: { appType: 'OIDC_APP_TYPE_NATIVE',     authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE'  },
};

/** Public client types (PKCE, no client_secret meaningfully returned). */
export function isPublicClient(t: ClientType): boolean {
  return t === 'spa' || t === 'native';
}

/**
 * Extract origin (scheme://host[:port]) from each callback URL, dedupe.
 * Zitadel requires additionalOrigins whitelist for SPA/PKCE CORS to work.
 * Auto-deriving covers 95% of cases (SPA hosted at same origin as callback).
 */
export function deriveAdditionalOrigins(callbackUrls: string[]): string[] {
  const origins = new Set<string>();
  for (const url of callbackUrls) {
    try { origins.add(new URL(url).origin); } catch { /* skip invalid — validation already ran */ }
  }
  return [...origins];
}

export interface OidcAppCreateInput {
  projectId: string;
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  clientType?: ClientType;   // default 'web' for backward compat
}

export interface OidcAppCreateResult {
  appId: string;
  clientId: string;
  clientSecret: string;   // shown ONCE — empty string for public clients (Zitadel returns none)
  clientType: ClientType;
}

function orgId(): string {
  const o = config.ZITADEL_ORG_ID;
  if (!o) throw new Error('ZITADEL_ORG_ID not configured');
  return o;
}

/**
 * Add OIDC app to a project. Returns clientId (+ clientSecret for confidential clients).
 * Throws on any non-2xx from Zitadel; caller responsible for rollback (RemoveProject).
 */
export async function addOidcApp(input: OidcAppCreateInput): Promise<OidcAppCreateResult> {
  const clientType = input.clientType ?? 'web';
  const { appType, authMethodType } = CLIENT_TYPE_MAP[clientType];
  const additionalOrigins = deriveAdditionalOrigins(input.redirectUris);

  const body = {
    name: input.name,
    redirectUris: input.redirectUris,
    responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
    grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
    appType,
    authMethodType,
    postLogoutRedirectUris: input.postLogoutRedirectUris ?? [],
    version: 'OIDC_VERSION_1_0',
    devMode: false,
    accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
    accessTokenRoleAssertion: true,
    idTokenRoleAssertion: true,
    idTokenUserinfoAssertion: true,
    additionalOrigins,
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
    clientSecret?: string;
  };

  logger.info(
    { project_id: input.projectId, app_id: parsed.appId, client_id: parsed.clientId, client_type: clientType },
    'zitadel-oidc-app: created',
  );

  return {
    appId: parsed.appId,
    clientId: parsed.clientId,
    clientSecret: parsed.clientSecret ?? '',
    clientType,
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

export interface OidcConfig {
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
async function getOidcAppConfig(
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
async function putOidcAppConfig(
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

/**
 * Find the (single) OIDC app in a project. Wizard creates 1 OIDC app per project,
 * so callers can rely on the first match. Returns null if project has zero OIDC apps.
 */
export async function findOidcAppByProject(
  projectId: string,
  targetOrgId: string,
): Promise<OidcAppSummary | null> {
  const apps = await listOidcApps(projectId, targetOrgId);
  return apps[0] ?? null;
}

/**
 * Reverse-map Zitadel enums back to user-facing client_type. Used when reading
 * OIDC config from Zitadel (e.g., GET /oidc-config endpoint) so UI can prefill
 * the client_type radio without querying rbac.apps.client_type separately.
 * Returns 'web' as fallback for unknown enum combinations.
 */
export function classifyClientType(cfg: OidcConfig): ClientType {
  const app = cfg.appType;
  const auth = cfg.authMethodType;
  if (app === 'OIDC_APP_TYPE_USER_AGENT' && auth === 'OIDC_AUTH_METHOD_TYPE_NONE') return 'spa';
  if (app === 'OIDC_APP_TYPE_NATIVE' && auth === 'OIDC_AUTH_METHOD_TYPE_NONE') return 'native';
  return 'web';
}

export interface PatchOidcAppInput {
  projectId: string;
  appId: string;
  targetOrgId?: string;
  clientType?: ClientType;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
}

/**
 * Merge-then-PUT patch: fetch current OIDC config, overlay caller's patch, PUT full body.
 * Preserves all fields the caller didn't specify (Zitadel PUT semantics = full replace).
 * Auto-derives additionalOrigins from final redirectUris.
 *
 * Guards public→confidential transition (throws) because Zitadel doesn't regenerate
 * client_secret on auth-method swap — separate regenerate endpoint required (out of scope).
 */
export async function patchOidcAppConfig(input: PatchOidcAppInput): Promise<{
  clientType: ClientType;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  additionalOrigins: string[];
}> {
  const orgIdRes = input.targetOrgId ?? config.ZITADEL_ORG_ID;
  if (!orgIdRes) throw new Error('patchOidcAppConfig: ZITADEL_ORG_ID not configured');

  const current = await getOidcAppConfig(input.projectId, input.appId, orgIdRes);
  if (!current) {
    throw new ZitadelHttpError(404, `OIDC app ${input.appId} not found in project ${input.projectId}`);
  }

  const currentType = classifyClientType(current);
  const nextType = input.clientType ?? currentType;

  // Guard: public → confidential requires secret regeneration (separate flow)
  if ((currentType === 'spa' || currentType === 'native') && nextType === 'web') {
    throw new ZitadelHttpError(
      400,
      'Cannot switch public client (spa/native) back to confidential (web) — client_secret regeneration not supported yet',
    );
  }

  const { appType, authMethodType } = CLIENT_TYPE_MAP[nextType];
  const redirectUris = input.redirectUris ?? current.redirectUris ?? [];
  const postLogoutRedirectUris = input.postLogoutRedirectUris ?? current.postLogoutRedirectUris ?? [];
  const additionalOrigins = deriveAdditionalOrigins(redirectUris);

  const merged: OidcConfig = {
    ...current,
    redirectUris,
    postLogoutRedirectUris,
    appType,
    authMethodType,
    additionalOrigins,
  };

  await putOidcAppConfig(input.projectId, input.appId, orgIdRes, merged);
  logger.info(
    {
      project_id: input.projectId,
      app_id: input.appId,
      old_client_type: currentType,
      new_client_type: nextType,
      redirect_count: redirectUris.length,
      origin_count: additionalOrigins.length,
    },
    'zitadel-oidc-app: patched',
  );

  return { clientType: nextType, redirectUris, postLogoutRedirectUris, additionalOrigins };
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
