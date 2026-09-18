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
import { isAdmin, requireMember } from '../middleware/require-admin-or-owner.js';
import { listUsersQuerySchema, userIdParamSchema } from '../schemas/user-schemas.js';
import { searchUsers, getUserById } from '../lib/zitadel-user-search-client.js';
import { listUserGrantsAllOrgs } from '../services/user-grant-sync.js';
import { getOrgById, getOrgsBatch } from '../lib/zitadel-org-client.js';
import { redis } from '../lib/redis-client.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { writerPool } from '../db/writer-pool.js';

const USER_DETAIL_CACHE_TTL = 60; // seconds

/** Cache key: separate by caller scope so member/admin don't share filtered/full response. */
function userDetailCacheKey(id: string, callerScope: string): string {
  return `user-detail:v2:${id}:${callerScope}`;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/users
   * Query: q (search string), limit (1-200, default 50), offset (default 0)
   * Returns: { data: UserSummary[], total: number }
   *
   * grant_count is null — caller must open drawer to get accurate count (GET /v1/users/:id).
   */
  app.get('/v1/users', { preHandler: [verifyJwt, requireMember] }, async (request, reply) => {
    const parsed = listUsersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
    }

    const { q, limit, offset } = parsed.data;
    const orgId = config.ZITADEL_ORG_ID || '';

    let users: Array<{ id: string; email: string; display_name: string; username?: string; home_org_id?: string; state?: string }>;
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
    // - Grant count: (Fix 2026-09-16) count DIRECT grants từ rbac.user_grants (không đếm
    //   Zitadel roleKeys expanded qua hierarchy). Trước đây count Zitadel sum → user có
    //   qlts.user (parent viewer) hiển thị 2 → gây confusion vs UI drawer show 1 direct.
    //   Query batch 1 lần thay vì N call Zitadel — nhanh hơn.
    const orgs = await getOrgsBatch(users.map((u) => u.home_org_id));
    const userIds = users.map((u) => u.id);
    let grantCountMap = new Map<string, number>();
    if (userIds.length > 0) {
      const { rows } = await writerPool.query<{ user_sub: string; cnt: string }>(
        `SELECT user_sub, count(*)::text AS cnt
           FROM rbac.user_grants
          WHERE user_sub = ANY($1::text[])
          GROUP BY user_sub`,
        [userIds],
      );
      grantCountMap = new Map(rows.map((r) => [r.user_sub, parseInt(r.cnt, 10)]));
    }
    const grantCounts = users.map((u) => grantCountMap.get(u.id) ?? 0);

    const data = users.map((u, i) => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      username: u.username,
      state: u.state,
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
  app.get('/v1/users/:id', { preHandler: [verifyJwt, requireMember] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'Invalid user id' });
    }

    const { id } = params.data;
    const orgId = config.ZITADEL_ORG_ID || '';
    const callerScope = isAdmin(request) ? 'admin' : `mem:${request.jwtClaims?.sub ?? 'anon'}`;
    const cacheKey = userDetailCacheKey(id, callerScope);

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
    let user: { id: string; email: string; display_name: string; username?: string; home_org_id?: string; state?: string } | null;
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

    // (Fix 2026-09-16) UI hiển thị inherited roles như direct grants gây nhầm lẫn admin.
    // Zitadel roleKeys expanded qua hierarchy (VD grant qlts.user → Zitadel có
    // [qlts.user, qlts.viewer] để JWT reflect inheritance). rbac.user_grants =
    // source of truth cho DIRECT grants. Query DB → filter Zitadel roleKeys chỉ
    // giữ direct grants → UI show đúng những gì admin đã grant.
    const { rows: directGrantRows } = await writerPool.query<{ role_key: string }>(
      `SELECT role_key FROM rbac.user_grants WHERE user_sub = $1`,
      [id],
    );
    const directRoleSet = new Set(directGrantRows.map((r) => r.role_key));

    // Ownership scope filter (2026-09-18): member chỉ thấy grants của user X trên
    // apps do member sở hữu (tránh data leak + UX hiển thị Revoke button không dùng được).
    // Admin thấy tất cả. Build set of Zitadel project_ids the caller can manage.
    let visibleProjectIds: Set<string> | null = null; // null = no filter (admin)
    if (!isAdmin(request)) {
      const callerSub = request.jwtClaims?.sub;
      if (!callerSub) {
        visibleProjectIds = new Set(); // fail-close
      } else {
        const { rows: ownedApps } = await writerPool.query<{ zitadel_project_id: string }>(
          `SELECT zitadel_project_id FROM rbac.apps
            WHERE created_by = $1 AND zitadel_project_id IS NOT NULL`,
          [callerSub],
        );
        visibleProjectIds = new Set(ownedApps.map((r) => r.zitadel_project_id));
      }
    }

    // Filter empty-role grants: leftovers from pre-fix updates that emptied roleKeys
    // instead of DELETE. UI would show them as bare "Thu hồi" rows.
    // Also filter each grant.roleKeys → only include direct grants (drop inherited).
    const grants = rawGrants
      .filter((g) => visibleProjectIds === null || visibleProjectIds.has(g.projectId))
      .map((g) => ({
        ...g,
        roleKeys: g.roleKeys.filter((rk) => directRoleSet.has(rk)),
      }))
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
      state: user.state,
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
