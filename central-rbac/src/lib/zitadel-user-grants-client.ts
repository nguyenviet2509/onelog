/**
 * zitadel-user-grants-client.ts — User grant operations for Zitadel Management API.
 * Covers: listUserGrants, addUserGrant, updateUserGrant, removeUserGrant.
 *
 * S1 gate findings (2026-08-25):
 *   - addUserGrant:    409 if grant for same project exists → treat as success
 *   - updateUserGrant: REPLACES full role set — caller must supply complete list
 *   - removeUserGrant: 404 on second call → treat as success
 *
 * M1 fix: listUserGrants paginates (PAGE_SIZE=100) until exhausted, cap at 10 000.
 * HTTP transport delegated to zitadel-http.ts.
 */
import { logger } from './logger.js';
import { mgmtPost, mgmtDelete, mgmtPut } from './zitadel-http.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserGrant {
  grantId: string;
  projectId: string;
  orgId: string;
  roleKeys: string[];
}

export interface AddUserGrantResult {
  grantId: string;
  /** false when a 409 was returned — grant already existed for this project */
  created: boolean;
}

// ── Internal response shapes ──────────────────────────────────────────────────

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

// ── Operations ────────────────────────────────────────────────────────────────

/**
 * List all grants for a user in a given org — paginated.
 * Maps to: POST /management/v1/users/grants/_search
 */
export async function listUserGrants(userId: string, orgId: string): Promise<UserGrant[]> {
  const path = `/management/v1/users/grants/_search`;
  const PAGE_SIZE = 100;
  const MAX_TOTAL = 10_000;
  const accumulated: UserGrant[] = [];
  let offset = 0;

  while (true) {
    let res: Response;
    try {
      res = await mgmtPost(path, orgId, {
        query: { offset: String(offset), limit: PAGE_SIZE },
        queries: [{ userIdQuery: { userId } }],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ userId, orgId, err: msg }, 'zitadel-mgmt: listUserGrants fetch failed');
      throw new Error(`Zitadel Mgmt API unreachable: ${msg}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error({ userId, orgId, status: res.status, body: text.slice(0, 200) }, 'zitadel-mgmt: listUserGrants non-2xx');
      throw new Error(`Zitadel Mgmt API error: HTTP ${res.status}`);
    }

    const data = (await res.json()) as ListGrantsResponse;
    const page: UserGrant[] = (data.result ?? []).map((g) => ({
      grantId: g.grantId ?? g.id ?? '',
      projectId: g.projectId ?? '',
      orgId: g.orgId ?? orgId,
      roleKeys: Array.isArray(g.roleKeys) ? g.roleKeys : [],
    }));

    accumulated.push(...page);

    if (accumulated.length >= MAX_TOTAL) {
      logger.warn({ userId, orgId, total: accumulated.length }, 'zitadel-mgmt: listUserGrants reached MAX_TOTAL — results may be incomplete');
      break;
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  logger.debug({ userId, orgId, grantCount: accumulated.length }, 'zitadel-mgmt: listUserGrants ok');
  return accumulated;
}

/**
 * Add a user grant (user ↔ project ↔ roles).
 * S1: 409 if user already has a grant for this project — treat as success.
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
 * Caller must supply the complete desired role list.
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
 * S1: 404 on second call → treat as success (already removed = goal achieved).
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
