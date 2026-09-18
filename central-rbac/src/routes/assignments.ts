/**
 * routes/assignments.ts — User role assignment endpoints.
 *
 * POST /v1/assignments         — assign role to user (enqueue outbox)
 * DELETE /v1/assignments/:id   — remove grant or specific role (enqueue outbox)
 * GET /v1/assignments          — list user grants from Zitadel (60s Redis cache)
 *
 * All mutations require JWT auth + audit log.
 * List uses Redis cache key: assignments:v1:{userId}:{projectId} TTL 60s.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyJwt } from '../middleware/auth-jwt.js';
import {
  isAdmin,
  requireMember,
} from '../middleware/require-admin-or-owner.js';
import { writeAuditLog } from '../middleware/audit-log.js';
import { assignRoleToUser, removeRoleFromUser, getUserGrants } from '../services/user-grant-sync.js';
import { enqueueOutbox } from '../db/queries/outbox.js';
import { writerPool } from '../db/writer-pool.js';
import { createHash } from 'node:crypto';
import { redis } from '../lib/redis-client.js';
import { logger } from '../lib/logger.js';

const assignBodySchema = z.object({
  user_id: z.string().min(1),
  role_key: z.string().min(1),
});

const revokeParamsSchema = z.object({
  id: z.string().min(1), // grantId
});

const revokeQuerySchema = z.object({
  /** Legacy single-role revoke — kept for backward compat with old UI. */
  role_key: z.string().min(1).optional(),
  /** Multi-role revoke: comma-separated list. Empty/omitted → full grant DELETE. */
  role_keys: z.string().min(1).optional(),
});

const listQuerySchema = z.object({
  user_id: z.string().min(1),
  project_id: z.string().optional(),
});

const CACHE_TTL_SEC = 60;

function assignmentsCacheKey(userId: string): string {
  return `assignments:v1:${userId}`;
}

/**
 * Bust all user-detail cache variants for a user (v2 keys are per-caller-scope,
 * so we SCAN-delete every `user-detail:v2:${userId}:*` key).
 */
async function invalidateUserDetailCache(userId: string): Promise<void> {
  const pattern = `user-detail:v2:${userId}:*`;
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== '0');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

/**
 * Invalidate pre-token webhook `user-grants:v{epoch}:{userId}` cache (2026-09-09 bug fix).
 *
 * Trước: bustUserCaches chỉ xóa 2 cache Central UI dùng (assignments, user-detail). Cache webhook
 * (5min TTL) không bị đụng → sau admin revoke role, user login lại vẫn nhận role list CŨ (có
 * role bị revoke) → qlts backend map thành group → user vẫn truy cập được dashboard trong 5 phút.
 *
 * Key format: user-grants:v{epoch}:{userId} — epoch bump khi resolve-epoch thay đổi (rare).
 * SCAN pattern-based delete: chỉ 1-2 key/user thường, không tốn kém.
 */
async function invalidateWebhookGrantsCache(userId: string): Promise<void> {
  const pattern = `user-grants:*:${userId}`;
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== '0');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

async function bustUserCaches(userId: string): Promise<void> {
  await Promise.all([
    redis.del(assignmentsCacheKey(userId)).catch(() => {}),
    invalidateUserDetailCache(userId).catch(() => {}),
    invalidateWebhookGrantsCache(userId).catch(() => {}),
  ]);
}

export async function assignmentRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/assignments — assign role to user
  app.post('/v1/assignments', { preHandler: [verifyJwt, requireMember] }, async (request, reply) => {
    const parsed = assignBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
    }

    const { user_id, role_key } = parsed.data;
    const grantorSub = request.jwtClaims?.sub;

    // Ownership check: member may only grant roles of apps they own.
    // Legacy roles (app_id=null, e.g. rbac.admin) → admin only.
    if (!isAdmin(request)) {
      const { rows: roleRows } = await writerPool.query<{ created_by: string | null; app_id: string | null }>(
        `SELECT a.created_by, r.app_id
           FROM rbac.roles r
           LEFT JOIN rbac.apps a ON a.id = r.app_id
          WHERE r.key = $1`,
        [role_key],
      );
      if (roleRows.length === 0) {
        return reply.status(404).send({ error: 'Role not found' });
      }
      if (!roleRows[0]!.app_id || !roleRows[0]!.created_by) {
        return reply.status(403).send({ error: 'Forbidden — cannot grant legacy/system role' });
      }
      if (roleRows[0]!.created_by !== grantorSub) {
        return reply.status(403).send({ error: 'Forbidden — cannot grant role of app not owned' });
      }
    }

    let result;
    try {
      result = await assignRoleToUser(user_id, role_key, request.id, grantorSub);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, user_id, role_key }, 'assignments: assignRoleToUser failed');
      return reply.status(502).send({ error: 'Failed to enqueue assignment', detail: msg });
    }

    // Invalidate both user-detail (used by drawer) + assignments caches
    await bustUserCaches(user_id);

    await writeAuditLog(request, {
      action: 'assignment.create',
      target_type: 'user_grant',
      target_id: `${user_id}:${role_key}`,
      after_state: { user_id, role_key, outbox_id: result.outbox.id, operation: result.operation },
    });

    return reply.status(202).send({
      status: 'queued',
      operation: result.operation,
      outbox_id: result.outbox.id,
      user_id,
      role_key,
    });
  });

  // DELETE /v1/assignments/:id — remove grant (or specific role from grant)
  app.delete('/v1/assignments/:id', { preHandler: [verifyJwt, requireMember] }, async (request, reply) => {
    const params = revokeParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'Invalid grant id' });
    }

    const query = revokeQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: 'Validation error', details: query.error.issues });
    }

    // user_id required in query for audit + cache invalidation
    const rawQuery = request.query as Record<string, string>;
    const userId = rawQuery['user_id'];
    if (!userId) {
      return reply.status(400).send({ error: 'user_id query param required' });
    }

    const grantId = params.data.id;
    // Accept either role_keys=csv (new) or role_key=single (legacy). Empty list
    // means full grant DELETE.
    const targetRoleKeys: string[] | undefined = query.data.role_keys
      ? query.data.role_keys.split(',').map((s) => s.trim()).filter(Boolean)
      : query.data.role_key
        ? [query.data.role_key]
        : undefined;

    const grantorSub = request.jwtClaims?.sub;

    // Ownership check for member: any role being revoked must belong to owned app.
    // Full grant DELETE (no targetRoleKeys) — member cannot revoke whole grant unless all
    // roles belong to owned apps; we conservatively reject full-grant DELETE for member.
    if (!isAdmin(request)) {
      if (!targetRoleKeys || targetRoleKeys.length === 0) {
        return reply.status(403).send({ error: 'Forbidden — member must specify role_keys to revoke (full-grant DELETE admin-only)' });
      }
      const { rows: roleRows } = await writerPool.query<{ role_key: string; created_by: string | null; app_id: string | null }>(
        `SELECT r.key AS role_key, a.created_by, r.app_id
           FROM rbac.roles r
           LEFT JOIN rbac.apps a ON a.id = r.app_id
          WHERE r.key = ANY($1::text[])`,
        [targetRoleKeys],
      );
      const notOwned = roleRows.filter((r) => !r.app_id || !r.created_by || r.created_by !== grantorSub);
      if (notOwned.length > 0) {
        return reply.status(403).send({
          error: 'Forbidden — cannot revoke role(s) of app not owned',
          rejected_roles: notOwned.map((r) => r.role_key),
        });
      }
    }

    let result;
    try {
      result = await removeRoleFromUser(userId, grantId, targetRoleKeys, request.id, grantorSub);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, userId, grantId }, 'assignments: removeRoleFromUser failed');
      return reply.status(502).send({ error: 'Failed to enqueue revocation', detail: msg });
    }

    await bustUserCaches(userId);

    // P2 immediate revoke (2026-09-09): enqueue notify_app_revoke để app-side (VD qlts) xóa
    // local session state (UserGroupMember + refresh_tokens) ngay. Không đợi TTL access token.
    // Skip nếu grant không map tới app trong rbac.apps (VD legacy grant), hoặc app không set
    // revoke_url (backward-compat với apps chưa implement webhook).
    if (result.grantProjectId) {
      const { rows: appRows } = await writerPool.query<{ id: string; revoke_url: string | null }>(
        `SELECT id, revoke_url FROM rbac.apps WHERE zitadel_project_id = $1 LIMIT 1`,
        [result.grantProjectId],
      );
      const app = appRows[0];
      if (app?.revoke_url) {
        // Time-bucket idempotency key (10s) — cho phép retry manual sau 10s nếu app fail
        const timeBucket = Math.floor(Date.now() / 10_000).toString();
        const notifyIdemKey = createHash('sha256')
          .update(`notify_app_revoke:${app.id}:${userId}:${timeBucket}`)
          .digest('hex')
          .slice(0, 64);
        await enqueueOutbox(
          writerPool,
          'notify_app_revoke',
          { appId: app.id, userId },
          notifyIdemKey,
          request.id,
        ).catch((err) => {
          // Enqueue fail không được block DELETE flow — log + tiếp tục (revoke đã sync Zitadel)
          logger.warn({ err, appId: app.id, userId }, 'assignments: notify_app_revoke enqueue failed');
        });
      }
    }

    await writeAuditLog(request, {
      action: 'assignment.delete',
      target_type: 'user_grant',
      target_id: grantId,
      before_state: { user_id: userId, grant_id: grantId, role_keys: targetRoleKeys },
    });

    return reply.status(202).send({
      status: 'queued',
      outbox_id: result.outbox.id,
      grant_id: grantId,
    });
  });

  // GET /v1/assignments?user_id=&project_id= — list grants from Zitadel (cached 60s)
  // Ownership scope (2026-09-18): admin sees all; member sees only grants on apps owned.
  // Cache stores unfiltered — filter applied per-request.
  app.get('/v1/assignments', { preHandler: [verifyJwt, requireMember] }, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: 'Validation error', details: query.error.issues });
    }

    const { user_id, project_id } = query.data;
    const cacheKey = assignmentsCacheKey(user_id);

    // Build ownership scope: null = admin (no filter), Set = allowed project_ids
    let visibleProjectIds: Set<string> | null = null;
    if (!isAdmin(request)) {
      const callerSub = request.jwtClaims?.sub;
      if (!callerSub) {
        return reply.send({ data: [], cached: false });
      }
      const { rows: ownedApps } = await writerPool.query<{ zitadel_project_id: string }>(
        `SELECT zitadel_project_id FROM rbac.apps
          WHERE created_by = $1 AND zitadel_project_id IS NOT NULL`,
        [callerSub],
      );
      visibleProjectIds = new Set(ownedApps.map((r) => r.zitadel_project_id));
    }

    const applyFilters = (grants: Array<{ projectId: string }>) => {
      let out = grants;
      if (visibleProjectIds) {
        out = out.filter((g) => visibleProjectIds!.has(g.projectId));
      }
      if (project_id) {
        out = out.filter((g) => g.projectId === project_id);
      }
      return out;
    };

    // Cache read
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const grants = JSON.parse(cached) as Array<{ projectId: string }>;
        return reply.send({ data: applyFilters(grants), cached: true });
      }
    } catch {
      // Redis unavailable — fall through to live fetch
    }

    let grants;
    try {
      grants = await getUserGrants(user_id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, user_id }, 'assignments: getUserGrants failed');
      return reply.status(502).send({ error: 'Failed to fetch grants from Zitadel', detail: msg });
    }

    // Cache write (non-blocking) — store unfiltered so all callers benefit
    redis.setex(cacheKey, CACHE_TTL_SEC, JSON.stringify(grants)).catch(() => {});

    return reply.send({ data: applyFilters(grants), cached: false });
  });
}
