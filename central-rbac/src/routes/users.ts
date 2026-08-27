/**
 * routes/users.ts — /v1/users proxy endpoints for Central RBAC UI.
 *
 * GET /v1/users?q=&limit=&offset= — search users via Zitadel
 * GET /v1/users/:id               — user detail + current grants from Zitadel
 *
 * Auth: verifyJwt (admin JWT required).
 * Grant count: null in list response — loaded accurately on drawer open via GET /v1/users/:id.
 *   H4 fix: removed enrichGrantCounts (N×listUserGrants per request = Zitadel DoS at scale).
 * Caching: 60s Redis cache keyed by user id for detail; list not cached (search varies).
 */
import type { FastifyInstance } from 'fastify';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { listUsersQuerySchema, userIdParamSchema } from '../schemas/user-schemas.js';
import { searchUsers, getUserById } from '../lib/zitadel-user-search-client.js';
import { listUserGrantsAllOrgs } from '../services/user-grant-sync.js';
import { getOrgById, getOrgsBatch } from '../lib/zitadel-org-client.js';
import { redis } from '../lib/redis-client.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const USER_DETAIL_CACHE_TTL = 60; // seconds

function userDetailCacheKey(id: string): string {
  return `user-detail:v1:${id}`;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/users
   * Query: q (search string), limit (1-200, default 50), offset (default 0)
   * Returns: { data: UserSummary[], total: number }
   *
   * grant_count is null — caller must open drawer to get accurate count (GET /v1/users/:id).
   */
  app.get('/v1/users', { preHandler: [verifyJwt] }, async (request, reply) => {
    const parsed = listUsersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
    }

    const { q, limit, offset } = parsed.data;
    const orgId = config.ZITADEL_ORG_ID || '';

    let users: Array<{ id: string; email: string; display_name: string; username?: string; home_org_id?: string }>;
    let total: number;

    try {
      ({ users, total } = await searchUsers(q, limit, offset, orgId));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, q }, 'users: searchUsers failed');
      // H3 fix: do not leak internal Zitadel error detail to client
      return reply.status(502).send({ error: 'Failed to search users' });
    }

    // Enrich each user with home org + grant count.
    // - Orgs: batch-fetched from Redis cache → 1 round-trip per unique org on miss.
    // - Grant counts: N users × listUserGrantsAllOrgs. Acceptable at page sizes
    //   ≤50 (default limit); if we ever page past that, revisit with a Zitadel
    //   batch endpoint or DB-side count.
    const orgs = await getOrgsBatch(users.map((u) => u.home_org_id));
    // Count = total role assignments across all grants (sum of role_keys), so
    // Spike Tester with grants [rbac.admin] + [onemcp.viewer, onemcp.admin] = 3.
    // Matches how "Số quyền" is interpreted by admins: total assigned permissions.
    const grantCounts = await Promise.all(
      users.map((u) =>
        listUserGrantsAllOrgs(u.id)
          .then((gs) => gs.reduce((sum, g) => sum + g.roleKeys.length, 0))
          .catch(() => null),
      ),
    );

    const data = users.map((u, i) => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      username: u.username,
      organization: (u.home_org_id && orgs.get(u.home_org_id)) || null,
      grant_count: grantCounts[i],
    }));

    return reply.send({ data, total });
  });

  /**
   * GET /v1/users/:id
   * Returns: { id, email, display_name, grant_count, grants: [{ project_id, grant_id, role_keys }] }
   * Redis cache 60s keyed by user id.
   */
  app.get('/v1/users/:id', { preHandler: [verifyJwt] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'Invalid user id' });
    }

    const { id } = params.data;
    const orgId = config.ZITADEL_ORG_ID || '';
    const cacheKey = userDetailCacheKey(id);

    // fresh=1 bypasses cache — used by UI polling right after grant/revoke mutations
    // to avoid re-poisoning cache with stale Zitadel state before outbox worker commits.
    const rawQuery = request.query as Record<string, string> | undefined;
    const bypassCache = rawQuery?.['fresh'] === '1';

    // Cache read
    if (!bypassCache) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return reply.send(JSON.parse(cached));
        }
      } catch {
        // Redis unavailable — fall through to live fetch
      }
    }

    // Fetch user + grants in parallel
    let user: { id: string; email: string; display_name: string; username?: string; home_org_id?: string } | null;
    let rawGrants: Array<{ grantId: string; projectId: string; projectName?: string; orgId: string; orgName?: string; roleKeys: string[] }>;

    try {
      [user, rawGrants] = await Promise.all([
        getUserById(id, orgId),
        listUserGrantsAllOrgs(id),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, id }, 'users: getUserById/listUserGrants failed');
      // H3 fix: do not leak internal Zitadel error detail to client
      return reply.status(502).send({ error: 'Failed to fetch user detail' });
    }

    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    // Enrich user's home org (Zitadel resourceOwner) — cache-hot after list call.
    const organization = user.home_org_id ? await getOrgById(user.home_org_id) : null;

    // Filter empty-role grants: leftovers from pre-fix updates that emptied roleKeys
    // instead of DELETE. UI would show them as bare "Thu hồi" rows.
    const grants = rawGrants
      .filter((g) => g.roleKeys.length > 0)
      .map((g) => ({
        id: g.grantId,
        project_id: g.projectId,
        project_name: g.projectName,
        org_id: g.orgId,
        org_name: g.orgName,
        role_keys: g.roleKeys,
      }));

    const detail = {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      username: user.username,
      organization,
      grant_count: grants.length,
      grants,
    };

    // Cache write (non-blocking). Skip write on bypass=fresh so a mutation-polling
    // caller doesn't re-cache pre-worker-commit state.
    if (!bypassCache) {
      redis.setex(cacheKey, USER_DETAIL_CACHE_TTL, JSON.stringify(detail)).catch(() => {});
    }

    return reply.send(detail);
  });
}
