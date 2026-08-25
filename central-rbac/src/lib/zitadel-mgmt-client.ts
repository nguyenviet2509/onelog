/**
 * zitadel-mgmt-client.ts — Minimal Zitadel Management API client.
 * Phase 2: only ListUserGrants is needed. PAT auth via ZITADEL_SA_PAT env.
 * Phase 3 upgrade: JWT client_credentials RFC 7523.
 *
 * Timeout: 3s per request.
 * Retry: once on 5xx (transient upstream error).
 */
import { config } from '../config.js';
import { logger } from './logger.js';

export interface UserGrant {
  grantId: string;
  projectId: string;
  orgId: string;
  roleKeys: string[];
}

// Zitadel Management API grant object shape (partial)
interface ZitadelGrantObject {
  grantId?: string;
  projectId?: string;
  orgId?: string;
  roleKeys?: string[];
}

interface ListGrantsResponse {
  result?: ZitadelGrantObject[];
}

const REQUEST_TIMEOUT_MS = 3000;

/**
 * Fetch Authorization header value.
 * Phase 2: simple PAT bearer token from env.
 * Phase 3: replace with JWT client_credentials (RFC 7523) with 55-min token cache.
 */
function getAuthHeader(): string {
  const pat = config.ZITADEL_SA_PAT;
  if (!pat) {
    throw new Error('ZITADEL_SA_PAT is not configured — cannot call Zitadel Mgmt API');
  }
  return `Bearer ${pat}`;
}

/**
 * POST to Zitadel Management API with timeout and one retry on 5xx.
 */
async function mgmtPost(path: string, orgId: string, body: unknown): Promise<Response> {
  const url = `${config.ZITADEL_MGMT_URL}${path}`;
  const authHeader = getAuthHeader();

  const doRequest = () =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
        'x-zitadel-orgid': orgId,
        // Zitadel resolves instance from Host header — must match ExternalDomain
        // when calling via internal Docker alias (e.g., authway-vps.local:8080)
        ...(config.ZITADEL_EXTERNAL_HOST ? { Host: config.ZITADEL_EXTERNAL_HOST } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  const res = await doRequest();

  // Retry once on 5xx (transient Zitadel error)
  if (res.status >= 500) {
    logger.warn({ status: res.status, path }, 'zitadel-mgmt: 5xx response, retrying once');
    return doRequest();
  }

  return res;
}

/**
 * Fetch all grants for a user in a given org.
 * Returns role keys grouped by project.
 *
 * Maps to: POST /management/v1/users/grants/_search (global search with userId filter)
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
    grantId: g.grantId ?? '',
    projectId: g.projectId ?? '',
    orgId: g.orgId ?? orgId,
    roleKeys: Array.isArray(g.roleKeys) ? g.roleKeys : [],
  }));

  logger.debug(
    { userId, orgId, grantCount: grants.length },
    'zitadel-mgmt: listUserGrants ok',
  );
  return grants;
}
