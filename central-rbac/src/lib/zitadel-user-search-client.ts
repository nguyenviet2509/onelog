/**
 * zitadel-user-search-client.ts — User search + detail via Zitadel Management API.
 *
 * searchUsers: POST /v2/users (instance-level search, not org-scoped).
 * getUserById: GET /v2/users/:id
 *
 * Note: /v2 endpoints use instance-level auth (no x-zitadel-orgid header needed
 * for search, but we send it for consistency). PAT must have IAM-level read access.
 *
 * Transport via zitadel-http.ts (mgmtPost + retry-once on 5xx).
 */
import { logger } from './logger.js';
import { mgmtPost, mgmtGet } from './zitadel-http.js';
import { ZitadelHttpError } from './zitadel-http-error.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ZitadelUserRaw {
  userId: string;
  username?: string;
  human?: {
    profile?: { displayName?: string; firstName?: string; lastName?: string };
    email?: { email?: string };
  };
  machine?: { name?: string };
  preferredLoginName?: string;
  loginNames?: string[];
  state?: string;
  /** Zitadel v2 returns details.resourceOwner = user's home org id */
  details?: { resourceOwner?: string };
}

/** Normalised lifecycle state — Phase 02 user-provision UI reads this. */
export type UserState = 'active' | 'inactive' | 'initial' | 'locked' | 'deleted' | 'suspend' | 'unspecified';

export interface UserSummary {
  id: string;
  email: string;
  display_name: string;
  username?: string;
  /** Home organization id from Zitadel details.resourceOwner (used for enrichment) */
  home_org_id?: string;
  /** Zitadel USER_STATE_* normalised to lowercase suffix. `initial` = created but has not verified email. */
  state?: UserState;
  /** Enriched from Central DB or Zitadel grants — 0 if unavailable */
  grant_count: number;
}

export interface UserDetail extends UserSummary {
  grants: Array<{
    project_id: string;
    role_keys: string[];
    grant_id: string;
  }>;
}

// ── Internal response shapes ──────────────────────────────────────────────────

interface SearchUsersResponse {
  result?: ZitadelUserRaw[];
  details?: { totalResult?: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeState(raw: string | undefined): UserState | undefined {
  if (!raw) return undefined;
  const suffix = raw.startsWith('USER_STATE_') ? raw.slice('USER_STATE_'.length).toLowerCase() : raw.toLowerCase();
  const known: UserState[] = ['active', 'inactive', 'initial', 'locked', 'deleted', 'suspend', 'unspecified'];
  return (known as string[]).includes(suffix) ? (suffix as UserState) : 'unspecified';
}

function normalizeUser(raw: ZitadelUserRaw): Omit<UserSummary, 'grant_count'> {
  const email =
    raw.human?.email?.email ??
    raw.preferredLoginName ??
    raw.loginNames?.[0] ??
    '';
  const humanFullName =
    `${raw.human?.profile?.firstName ?? ''} ${raw.human?.profile?.lastName ?? ''}`.trim();
  const displayName =
    raw.human?.profile?.displayName ??
    (humanFullName || null) ??
    raw.machine?.name ??
    raw.username ??
    email;

  return {
    id: raw.userId,
    email,
    display_name: displayName,
    username: raw.username,
    home_org_id: raw.details?.resourceOwner,
    state: normalizeState(raw.state),
  };
}

// ── Operations ────────────────────────────────────────────────────────────────

/**
 * Search users in Zitadel (instance-level, /v2/users).
 * If q is non-empty, filters by username OR email CONTAINS.
 */
export async function searchUsers(
  q: string,
  limit: number,
  offset: number,
  orgId: string,
): Promise<{ users: Array<Omit<UserSummary, 'grant_count'>>; total: number }> {
  const body: Record<string, unknown> = {
    query: { limit, offset: String(offset) },
  };

  if (q) {
    body['queries'] = [
      {
        orQuery: {
          queries: [
            { userNameQuery: { userName: q, method: 'TEXT_QUERY_METHOD_CONTAINS' } },
            { emailQuery: { emailAddress: q, method: 'TEXT_QUERY_METHOD_CONTAINS' } },
          ],
        },
      },
    ];
  }

  let res: Response;
  try {
    res = await mgmtPost('/v2/users', orgId, body);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ q, err: msg }, 'zitadel-user-search: searchUsers fetch failed');
    throw new Error(`Zitadel user search unreachable: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ q, status: res.status, body: text.slice(0, 200) }, 'zitadel-user-search: searchUsers non-2xx');
    throw new ZitadelHttpError(res.status, `Zitadel user search error: HTTP ${res.status}`);
  }

  const data = (await res.json()) as SearchUsersResponse;
  const users = (data.result ?? []).map(normalizeUser);
  const total = parseInt(data.details?.totalResult ?? String(users.length), 10);

  logger.debug({ q, limit, offset, returned: users.length, total }, 'zitadel-user-search: ok');
  return { users, total };
}

/**
 * Get a single user by ID from Zitadel (/v2/users/:id — GET).
 * Returns null if 404. Uses shared mgmtGet for consistent 5xx retry behavior.
 */
export async function getUserById(
  userId: string,
  orgId: string,
): Promise<Omit<UserSummary, 'grant_count'> | null> {
  let res: Response;
  try {
    res = await mgmtGet(`/v2/users/${encodeURIComponent(userId)}`, orgId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ userId, err: msg }, 'zitadel-user-search: getUserById fetch failed');
    throw new Error(`Zitadel get user unreachable: ${msg}`);
  }

  if (res.status === 404) return null;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ userId, status: res.status, body: text.slice(0, 200) }, 'zitadel-user-search: getUserById non-2xx');
    throw new ZitadelHttpError(res.status, `Zitadel get user error: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { user?: ZitadelUserRaw };
  if (!data.user) return null;

  logger.debug({ userId }, 'zitadel-user-search: getUserById ok');
  return normalizeUser(data.user);
}
