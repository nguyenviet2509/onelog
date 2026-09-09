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

function userDetailCacheKey(userId: string): string {
  return `user-detail:v1:${userId}`;
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
    redis.del(userDetailCacheKey(userId)).catch(() => {}),
    invalidateWebhookGrantsCache(userId).catch(() => {}),
  ]);
}

export async function assignmentRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/assignments — assign role to user
  app.post('/v1/assignments', { preHandler: [verifyJwt] }, async (request, reply) => {
    const parsed = assignBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
    }

    const { user_id, role_key } = parsed.data;

    let result;
    try {
      result = await assignRoleToUser(user_id, role_key, request.id);
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
  app.delete('/v1/assignments/:id', { preHandler: [verifyJwt] }, async (request, reply) => {
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

    let result;
    try {
      result = await removeRoleFromUser(userId, grantId, targetRoleKeys, request.id);
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
  app.get('/v1/assignments', { preHandler: [verifyJwt] }, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: 'Validation error', details: query.error.issues });
    }

    const { user_id, project_id } = query.data;
    const cacheKey = assignmentsCacheKey(user_id);

    // Cache read
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const grants = JSON.parse(cached) as unknown[];
        const filtered = project_id
          ? (grants as Array<{ projectId: string }>).filter((g) => g.projectId === project_id)
          : grants;
        return reply.send({ data: filtered, cached: true });
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

    // Cache write (non-blocking)
    redis.setex(cacheKey, CACHE_TTL_SEC, JSON.stringify(grants)).catch(() => {});

    const filtered = project_id ? grants.filter((g) => g.projectId === project_id) : grants;
    return reply.send({ data: filtered, cached: false });
  });
}
