/**
 * zitadel-org-client.ts — Fetch Zitadel org detail (name + primaryDomain).
 * Redis-cached 300s. Used to enrich user list / drawer / grant dialog UI.
 *
 * Zero-effort org visibility: no local rbac.orgs table, no cron. Cache miss →
 * one Zitadel Management GET, populate Redis. Rename lag = up to 5 min.
 */
import { mgmtGet } from './zitadel-http.js';
import { redis } from './redis-client.js';
import { logger } from './logger.js';

const CACHE_TTL_SEC = 300;
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

  let res: Response;
  try {
    res = await mgmtGet(`/management/v1/orgs/${orgId}`, orgId);
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
