/**
 * zitadel-org-client.ts — Fetch Zitadel org detail (name + primaryDomain).
 * Redis-cached 300s. Used to enrich user list / drawer / grant dialog UI.
 *
 * Zero-effort org visibility: no local rbac.orgs table, no cron. Cache miss →
 * one Zitadel Management GET, populate Redis. Rename lag = up to 5 min.
 */
import { mgmtGet, mgmtPost } from './zitadel-http.js';
import { redis } from './redis-client.js';
import { logger } from './logger.js';

const CACHE_TTL_SEC = 300;
const LIST_CACHE_TTL_SEC = 60;
const LIST_CACHE_KEY = 'org:list:v1';
const cacheKey = (id: string): string => `org:v1:${id}`;

export interface OrgSummary {
  id: string;
  name: string;
  primaryDomain: string;
}

interface ZitadelOrgResponse {
  org?: {
    id: string;
    name: string;
    primaryDomain?: string;
  };
}

export async function getOrgById(orgId: string): Promise<OrgSummary | null> {
  if (!orgId) return null;
  const key = cacheKey(orgId);

  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as OrgSummary;
  } catch {
    // Redis unavailable → fall through to live fetch
  }

  // Zitadel Management API only exposes `/management/v1/orgs/me` (scoped by
  // x-zitadel-orgid header). Path-param org fetch does not exist in v4 — the
  // header identifies which org's context the request runs in, and /me returns
  // that org's detail. Pattern works cross-org because SA PAT has IAM read scope.
  let res: Response;
  try {
    res = await mgmtGet(`/management/v1/orgs/me`, orgId);
  } catch (err) {
    logger.warn({ orgId, err }, 'zitadel-org: fetch failed');
    return null;
  }

  if (!res.ok) {
    logger.warn({ orgId, status: res.status }, 'zitadel-org: fetch non-2xx');
    return null;
  }

  const body = (await res.json()) as ZitadelOrgResponse;
  if (!body.org) return null;

  const summary: OrgSummary = {
    id: body.org.id,
    name: body.org.name,
    primaryDomain: body.org.primaryDomain ?? '',
  };

  redis.setex(key, CACHE_TTL_SEC, JSON.stringify(summary)).catch(() => {});
  return summary;
}

/**
 * Batch fetch multiple orgs — dedupes ids + fires Promise.all. Returns Map
 * so callers can `orgs.get(userOrgId)` in O(1) while enriching a list response.
 */
export async function getOrgsBatch(orgIds: Array<string | undefined | null>): Promise<Map<string, OrgSummary>> {
  const unique = Array.from(new Set(orgIds.filter((id): id is string => !!id)));
  const results = await Promise.all(unique.map(async (id) => [id, await getOrgById(id)] as const));
  const map = new Map<string, OrgSummary>();
  for (const [id, org] of results) {
    if (org) map.set(id, org);
  }
  return map;
}

/**
 * List ALL orgs the Zitadel instance exposes. Requires SA to have IAM_OWNER
 * (or IAM_ORG_MANAGER). Cached 60s in Redis to keep the apps/projects list
 * page responsive while still picking up new orgs within a minute.
 *
 * Zitadel Admin API: POST /admin/v1/orgs/_search. The x-zitadel-orgid header
 * is ignored by admin endpoints — caller passes any non-empty value.
 */
export async function listAllOrgs(headerOrgId: string): Promise<OrgSummary[]> {
  try {
    const cached = await redis.get(LIST_CACHE_KEY);
    if (cached) return JSON.parse(cached) as OrgSummary[];
  } catch {
    // Redis unavailable → live fetch
  }

  let res: Response;
  try {
    res = await mgmtPost('/admin/v1/orgs/_search', headerOrgId, {});
  } catch (err) {
    logger.warn({ err }, 'zitadel-org: listAllOrgs fetch failed');
    return [];
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ status: res.status, body: body.slice(0, 200) }, 'zitadel-org: listAllOrgs non-2xx');
    return [];
  }

  const parsed = (await res.json()) as {
    result?: Array<{ id: string; name: string; primaryDomain?: string; state?: string }>;
  };
  const orgs: OrgSummary[] = (parsed.result ?? [])
    .filter((o) => o.state !== 'ORG_STATE_REMOVED')
    .map((o) => ({
      id: o.id,
      name: o.name,
      primaryDomain: o.primaryDomain ?? '',
    }));

  redis.setex(LIST_CACHE_KEY, LIST_CACHE_TTL_SEC, JSON.stringify(orgs)).catch(() => {});
  return orgs;
}
