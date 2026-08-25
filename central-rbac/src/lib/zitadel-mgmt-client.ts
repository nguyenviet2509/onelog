/**
 * zitadel-mgmt-client.ts — Zitadel Management API client.
 * Phase 2: listUserGrants (PAT auth).
 * Phase 3: addProjectRole, removeProjectRole, addUserGrant, updateUserGrant,
 *          removeUserGrant, listProjectRoles — all with 3s timeout + retry-once on 5xx.
 *
 * S1 gate findings (2026-08-25):
 *   - addProjectRole:    409 on duplicate → caller treats as success
 *   - removeProjectRole: 200 idempotent (always safe)
 *   - addUserGrant:      409 if grant for same project exists → use updateUserGrant
 *   - updateUserGrant:   REPLACES full role set (not merge) → caller must supply complete list
 *   - removeUserGrant:   404 on second call → caller treats as success
 *
 * SA: IAM_OWNER PAT from ZITADEL_SA_PAT env (Phase 3 accepts IAM_OWNER per gate S2).
 * Phase 5: upgrade to JWT client_credentials (RFC 7523) + custom minimal role if Zitadel adds support.
 */
import { config } from '../config.js';
import { logger } from './logger.js';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface UserGrant {
  grantId: string;
  projectId: string;
  orgId: string;
  roleKeys: string[];
}

export interface ProjectRole {
  roleKey: string;
  displayName: string;
  group: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 3000;
const RETRY_DELAY_MS = 500;

function getAuthHeader(): string {
  const pat = config.ZITADEL_SA_PAT;
  if (!pat) {
    throw new Error('ZITADEL_SA_PAT is not configured — cannot call Zitadel Mgmt API');
  }
  return `Bearer ${pat}`;
}

function buildHeaders(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: getAuthHeader(),
    'x-zitadel-orgid': orgId,
    // Zitadel resolves instance from Host header when called via internal Docker alias
    ...(config.ZITADEL_EXTERNAL_HOST ? { Host: config.ZITADEL_EXTERNAL_HOST } : {}),
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST to Zitadel Mgmt API — retry once on 5xx after 500ms. */
async function mgmtPost(path: string, orgId: string, body: unknown): Promise<Response> {
  const url = `${config.ZITADEL_MGMT_URL}${path}`;
  const doRequest = () =>
    fetch(url, {
      method: 'POST',
      headers: buildHeaders(orgId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  const res = await doRequest();
  if (res.status >= 500) {
    logger.warn({ status: res.status, path }, 'zitadel-mgmt: 5xx, retrying once');
    await sleep(RETRY_DELAY_MS);
    return doRequest();
  }
  return res;
}

/** DELETE to Zitadel Mgmt API — retry once on 5xx after 500ms. */
async function mgmtDelete(path: string, orgId: string): Promise<Response> {
  const url = `${config.ZITADEL_MGMT_URL}${path}`;
  const doRequest = () =>
    fetch(url, {
      method: 'DELETE',
      headers: buildHeaders(orgId),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  const res = await doRequest();
  if (res.status >= 500) {
    logger.warn({ status: res.status, path }, 'zitadel-mgmt: 5xx DELETE, retrying once');
    await sleep(RETRY_DELAY_MS);
    return doRequest();
  }
  return res;
}

/** PUT to Zitadel Mgmt API — retry once on 5xx after 500ms. */
async function mgmtPut(path: string, orgId: string, body: unknown): Promise<Response> {
  const url = `${config.ZITADEL_MGMT_URL}${path}`;
  const doRequest = () =>
    fetch(url, {
      method: 'PUT',
      headers: buildHeaders(orgId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  const res = await doRequest();
  if (res.status >= 500) {
    logger.warn({ status: res.status, path }, 'zitadel-mgmt: 5xx PUT, retrying once');
    await sleep(RETRY_DELAY_MS);
    return doRequest();
  }
  return res;
}

// ── Phase 2 ───────────────────────────────────────────────────────────────────

interface ZitadelGrantObject {
  grantId?: string;
  id?: string; // some endpoints return 'id' not 'grantId'
  projectId?: string;
  orgId?: string;
  roleKeys?: string[];
}

interface ListGrantsResponse {
  result?: ZitadelGrantObject[];
}

/**
 * List all grants for a user in a given org.
 * Maps to: POST /management/v1/users/grants/_search
 */
export async function listUserGrants(userId: string, orgId: string): Promise<UserGrant[]> {
  const path = `/management/v1/users/grants/_search`;
  let res: Response;
  try {
    res = await mgmtPost(path, orgId, {
      query: { offset: '0', limit: 100 },
      queries: [{ userIdQuery: { userId } }],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ userId, orgId, err: msg }, 'zitadel-mgmt: listUserGrants fetch failed');
    throw new Error(`Zitadel Mgmt API unreachable: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error(
      { userId, orgId, status: res.status, body: text.slice(0, 200) },
      'zitadel-mgmt: listUserGrants non-2xx',
    );
    throw new Error(`Zitadel Mgmt API error: HTTP ${res.status}`);
  }

  const data = (await res.json()) as ListGrantsResponse;
  const grants: UserGrant[] = (data.result ?? []).map((g) => ({
    grantId: g.grantId ?? g.id ?? '',
    projectId: g.projectId ?? '',
    orgId: g.orgId ?? orgId,
    roleKeys: Array.isArray(g.roleKeys) ? g.roleKeys : [],
  }));

  logger.debug({ userId, orgId, grantCount: grants.length }, 'zitadel-mgmt: listUserGrants ok');
  return grants;
}

// ── Phase 3 — role management ─────────────────────────────────────────────────

/**
 * Add a project role to Zitadel.
 * S1: returns 409 on duplicate — caller should treat 409 as success.
 * Maps to: POST /management/v1/projects/{projectId}/roles
 */
export async function addProjectRole(
  projectId: string,
  orgId: string,
  roleKey: string,
  displayName: string,
  group?: string,
): Promise<{ created: boolean }> {
  const path = `/management/v1/projects/${encodeURIComponent(projectId)}/roles`;
  let res: Response;
  try {
    res = await mgmtPost(path, orgId, { roleKey, displayName, group: group ?? '' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ projectId, roleKey, err: msg }, 'zitadel-mgmt: addProjectRole fetch failed');
    throw new Error(`Zitadel Mgmt API unreachable: ${msg}`);
  }

  // 409 = duplicate — idempotency won; treat as success
  if (res.status === 409) {
    logger.info({ projectId, roleKey }, 'zitadel-mgmt: addProjectRole 409 (already exists) — treating as success');
    return { created: false };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ projectId, roleKey, status: res.status, body: text.slice(0, 200) }, 'zitadel-mgmt: addProjectRole failed');
    throw new Error(`Zitadel addProjectRole error: HTTP ${res.status}`);
  }

  logger.info({ projectId, roleKey }, 'zitadel-mgmt: addProjectRole ok');
  return { created: true };
}

/**
 * Remove a project role from Zitadel.
 * S1: returns 200 idempotently (second call = same 200 response). Always safe.
 * Maps to: DELETE /management/v1/projects/{projectId}/roles/{roleKey}
 */
export async function removeProjectRole(
  projectId: string,
  orgId: string,
  roleKey: string,
): Promise<void> {
  const path = `/management/v1/projects/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(roleKey)}`;
  let res: Response;
  try {
    res = await mgmtDelete(path, orgId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ projectId, roleKey, err: msg }, 'zitadel-mgmt: removeProjectRole fetch failed');
    throw new Error(`Zitadel Mgmt API unreachable: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ projectId, roleKey, status: res.status, body: text.slice(0, 200) }, 'zitadel-mgmt: removeProjectRole failed');
    throw new Error(`Zitadel removeProjectRole error: HTTP ${res.status}`);
  }

  logger.info({ projectId, roleKey }, 'zitadel-mgmt: removeProjectRole ok');
}

// ── Phase 3 — user grant management ──────────────────────────────────────────

export interface AddUserGrantResult {
  grantId: string;
  created: boolean; // false = 409, grant already existed
}

/**
 * Add a user grant (user ↔ project ↔ roles).
 * S1: 409 if user already has a grant for this project — treat as success;
 *     caller must use updateUserGrant to modify existing grants.
 * Maps to: POST /management/v1/users/{userId}/grants
 */
export async function addUserGrant(
  userId: string,
  orgId: string,
  projectId: string,
  roleKeys: string[],
): Promise<AddUserGrantResult> {
  const path = `/management/v1/users/${encodeURIComponent(userId)}/grants`;
  let res: Response;
  try {
    res = await mgmtPost(path, orgId, { projectId, roleKeys });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ userId, projectId, err: msg }, 'zitadel-mgmt: addUserGrant fetch failed');
    throw new Error(`Zitadel Mgmt API unreachable: ${msg}`);
  }

  // 409 = grant for this project already exists — idempotency; treat as success
  if (res.status === 409) {
    logger.info({ userId, projectId }, 'zitadel-mgmt: addUserGrant 409 (grant exists) — treating as success');
    return { grantId: '', created: false };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ userId, projectId, status: res.status, body: text.slice(0, 200) }, 'zitadel-mgmt: addUserGrant failed');
    throw new Error(`Zitadel addUserGrant error: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { userGrantId?: string };
  const grantId = data.userGrantId ?? '';
  logger.info({ userId, projectId, grantId }, 'zitadel-mgmt: addUserGrant ok');
  return { grantId, created: true };
}

/**
 * Update a user grant — REPLACES the full role set (Zitadel semantics).
 * Caller must supply the complete desired role list, not just additions.
 * Maps to: PUT /management/v1/users/{userId}/grants/{grantId}
 */
export async function updateUserGrant(
  userId: string,
  orgId: string,
  grantId: string,
  roleKeys: string[],
): Promise<void> {
  const path = `/management/v1/users/${encodeURIComponent(userId)}/grants/${encodeURIComponent(grantId)}`;
  let res: Response;
  try {
    res = await mgmtPut(path, orgId, { roleKeys });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ userId, grantId, err: msg }, 'zitadel-mgmt: updateUserGrant fetch failed');
    throw new Error(`Zitadel Mgmt API unreachable: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ userId, grantId, status: res.status, body: text.slice(0, 200) }, 'zitadel-mgmt: updateUserGrant failed');
    throw new Error(`Zitadel updateUserGrant error: HTTP ${res.status}`);
  }

  logger.info({ userId, grantId, roleCount: roleKeys.length }, 'zitadel-mgmt: updateUserGrant ok');
}

/**
 * Remove a user grant by grantId.
 * S1: 404 on second call → caller treats 404 as success (already removed = goal achieved).
 * Maps to: DELETE /management/v1/users/{userId}/grants/{grantId}
 */
export async function removeUserGrant(
  userId: string,
  orgId: string,
  grantId: string,
): Promise<void> {
  const path = `/management/v1/users/${encodeURIComponent(userId)}/grants/${encodeURIComponent(grantId)}`;
  let res: Response;
  try {
    res = await mgmtDelete(path, orgId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ userId, grantId, err: msg }, 'zitadel-mgmt: removeUserGrant fetch failed');
    throw new Error(`Zitadel Mgmt API unreachable: ${msg}`);
  }

  // 404 = grant already removed — idempotency; treat as success
  if (res.status === 404) {
    logger.info({ userId, grantId }, 'zitadel-mgmt: removeUserGrant 404 (already removed) — treating as success');
    return;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ userId, grantId, status: res.status, body: text.slice(0, 200) }, 'zitadel-mgmt: removeUserGrant failed');
    throw new Error(`Zitadel removeUserGrant error: HTTP ${res.status}`);
  }

  logger.info({ userId, grantId }, 'zitadel-mgmt: removeUserGrant ok');
}

// ── Phase 3 — read endpoints ──────────────────────────────────────────────────

interface ListProjectRolesResponse {
  result?: Array<{ roleKey?: string; displayName?: string; group?: string }>;
}

/**
 * List all roles defined on a Zitadel project.
 * Maps to: POST /management/v1/projects/{projectId}/roles/_search
 */
export async function listProjectRoles(
  projectId: string,
  orgId: string,
): Promise<ProjectRole[]> {
  const path = `/management/v1/projects/${encodeURIComponent(projectId)}/roles/_search`;
  let res: Response;
  try {
    res = await mgmtPost(path, orgId, { query: { offset: '0', limit: 200 } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ projectId, err: msg }, 'zitadel-mgmt: listProjectRoles fetch failed');
    throw new Error(`Zitadel Mgmt API unreachable: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ projectId, status: res.status, body: text.slice(0, 200) }, 'zitadel-mgmt: listProjectRoles failed');
    throw new Error(`Zitadel listProjectRoles error: HTTP ${res.status}`);
  }

  const data = (await res.json()) as ListProjectRolesResponse;
  return (data.result ?? []).map((r) => ({
    roleKey: r.roleKey ?? '',
    displayName: r.displayName ?? '',
    group: r.group ?? '',
  }));
}
