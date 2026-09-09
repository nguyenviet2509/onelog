/**
 * zitadel-project-roles-client.ts — Project role operations for Zitadel Management API.
 * Covers: addProjectRole, removeProjectRole, listProjectRoles.
 *
 * S1 gate findings (2026-08-25):
 *   - addProjectRole:    409 on duplicate → treat as success (idempotent)
 *   - removeProjectRole: 200 idempotent — always safe to call twice
 *
 * M1 fix: listProjectRoles paginates (PAGE_SIZE=200) until exhausted, cap at 10 000.
 * HTTP transport delegated to zitadel-http.ts.
 */
import { logger } from './logger.js';
import { mgmtPost, mgmtPut, mgmtDelete } from './zitadel-http.js';
import { ZitadelHttpError } from './zitadel-http-error.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectRole {
  roleKey: string;
  displayName: string;
  group: string;
}

// ── Internal response shapes ──────────────────────────────────────────────────

interface ListProjectRolesResponse {
  result?: Array<{ roleKey?: string; displayName?: string; group?: string }>;
}

// ── Operations ────────────────────────────────────────────────────────────────

/**
 * Add a project role to Zitadel.
 * S1: 409 on duplicate — treat as success.
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

  if (res.status === 409) {
    logger.info({ projectId, roleKey }, 'zitadel-mgmt: addProjectRole 409 (already exists) — treating as success');
    return { created: false };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ projectId, roleKey, status: res.status, body: text.slice(0, 200) }, 'zitadel-mgmt: addProjectRole failed');
    throw new ZitadelHttpError(res.status, `Zitadel addProjectRole error: HTTP ${res.status}`);
  }

  logger.info({ projectId, roleKey }, 'zitadel-mgmt: addProjectRole ok');
  return { created: true };
}

/**
 * Update a project role's displayName / group in Zitadel.
 * Maps to: PUT /management/v1/projects/{projectId}/roles/{roleKey}
 *
 * Idempotency: PUT is naturally idempotent; retries with same body → same state.
 * 404 → role doesn't exist in Zitadel → treat as success (Central-side truth
 * is that the role should have displayName X; if role is gone, another cleanup
 * event already handled it — no useful action).
 */
export async function updateProjectRole(
  projectId: string,
  orgId: string,
  roleKey: string,
  displayName: string,
  group?: string,
): Promise<void> {
  const path = `/management/v1/projects/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(roleKey)}`;
  let res: Response;
  try {
    res = await mgmtPut(path, orgId, { displayName, group: group ?? '' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ projectId, roleKey, err: msg }, 'zitadel-mgmt: updateProjectRole fetch failed');
    throw new Error(`Zitadel Mgmt API unreachable: ${msg}`);
  }
  if (res.status === 404) {
    logger.info({ projectId, roleKey }, 'zitadel-mgmt: updateProjectRole 404 (role gone) — treating as success');
    return;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ projectId, roleKey, status: res.status, body: text.slice(0, 200) }, 'zitadel-mgmt: updateProjectRole failed');
    throw new ZitadelHttpError(res.status, `Zitadel updateProjectRole error: HTTP ${res.status}`);
  }
  logger.info({ projectId, roleKey, displayName }, 'zitadel-mgmt: updateProjectRole ok');
}

/**
 * Remove a project role from Zitadel.
 * S1: 200 idempotent — second call returns same 200. Always safe.
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
    throw new ZitadelHttpError(res.status, `Zitadel removeProjectRole error: HTTP ${res.status}`);
  }
  logger.info({ projectId, roleKey }, 'zitadel-mgmt: removeProjectRole ok');
}

/**
 * List all roles defined on a Zitadel project — paginated.
 * M1 fix: loops until exhausted, warns if total exceeds MAX_TOTAL.
 * Maps to: POST /management/v1/projects/{projectId}/roles/_search
 */
export async function listProjectRoles(
  projectId: string,
  orgId: string,
): Promise<ProjectRole[]> {
  const path = `/management/v1/projects/${encodeURIComponent(projectId)}/roles/_search`;
  const PAGE_SIZE = 200;
  const MAX_TOTAL = 10_000;
  const accumulated: ProjectRole[] = [];
  let offset = 0;

  while (true) {
    let res: Response;
    try {
      res = await mgmtPost(path, orgId, { query: { offset: String(offset), limit: PAGE_SIZE } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ projectId, err: msg }, 'zitadel-mgmt: listProjectRoles fetch failed');
      throw new Error(`Zitadel Mgmt API unreachable: ${msg}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error({ projectId, status: res.status, body: text.slice(0, 200) }, 'zitadel-mgmt: listProjectRoles failed');
      throw new ZitadelHttpError(res.status, `Zitadel listProjectRoles error: HTTP ${res.status}`);
    }

    const data = (await res.json()) as ListProjectRolesResponse;
    const page: ProjectRole[] = (data.result ?? []).map((r) => ({
      roleKey: r.roleKey ?? '',
      displayName: r.displayName ?? '',
      group: r.group ?? '',
    }));

    accumulated.push(...page);

    if (accumulated.length >= MAX_TOTAL) {
      logger.warn({ projectId, total: accumulated.length }, 'zitadel-mgmt: listProjectRoles reached MAX_TOTAL — results may be incomplete');
      break;
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  logger.debug({ projectId, roleCount: accumulated.length }, 'zitadel-mgmt: listProjectRoles ok');
  return accumulated;
}
