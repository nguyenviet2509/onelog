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
  role_key: z.string().min(1).optional(), // if present, partial revoke
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

async function bustUserCaches(userId: string): Promise<void> {
  await Promise.all([
    redis.del(assignmentsCacheKey(userId)).catch(() => {}),
    redis.del(userDetailCacheKey(userId)).catch(() => {}),
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
    const targetRoleKey = query.data.role_key;

    let result;
    try {
      result = await removeRoleFromUser(userId, grantId, targetRoleKey, request.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, userId, grantId }, 'assignments: removeRoleFromUser failed');
      return reply.status(502).send({ error: 'Failed to enqueue revocation', detail: msg });
    }

    await bustUserCaches(userId);

    await writeAuditLog(request, {
      action: 'assignment.delete',
      target_type: 'user_grant',
      target_id: grantId,
      before_state: { user_id: userId, grant_id: grantId, role_key: targetRoleKey },
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
