/**
 * routes/resolve-v2.ts — POST /v2/resolve
 *
 * Phase 09 (plan 260910-1334). Fork /v1/resolve với 3 khác biệt:
 *   1. Input body: {user_sub, app_slug, tenant_id?} thay {roles[]} — Central là source of truth grants
 *   2. Tenant filter — union global + tenant-scoped grants
 *   3. Response bao gồm per-app epoch cho SDK cache invalidation
 *
 * Auth: reuse verifyResolveAuth (X-Rbac-Token OR zitadel-signature) — không tạo SA JWT flow mới.
 * Scope check inline: verify user có grant trong app_slug trước khi trả permissions
 *   → chống 1 app enum user cross-app khi token leak.
 * Cache: Redis 60s TTL, key includes epoch → grant mutation auto-invalidates cache.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyResolveAuth } from '../middleware/auth-resolve.js';
import { resolvePermissionsV2, userHasGrantInApp } from '../db/queries/resolve-v2.js';
import { getCachedResolveV2, setCachedResolveV2 } from '../lib/resolve-cache.js';
import { writerPool } from '../db/writer-pool.js';
import { getAppEpoch } from '../db/queries/resolve-v2.js';

const resolveV2BodySchema = z.object({
  user_sub: z.string().min(1).max(256),
  app_slug: z.string().regex(/^[a-z][a-z0-9-]{2,31}$/),
  tenant_id: z.string().max(256).nullable().optional(),
});

export async function resolveV2Routes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v2/resolve',
    { preHandler: [verifyResolveAuth] },
    async (request, reply) => {
      const parsed = resolveV2BodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation error',
          details: parsed.error.issues,
        });
      }

      const { user_sub, app_slug } = parsed.data;
      const tenant_id = parsed.data.tenant_id ?? null;

      // Inline scope check — verify user has ANY grant in app (chống enum cross-app)
      const hasGrants = await userHasGrantInApp(writerPool, user_sub, app_slug);
      if (!hasGrants) {
        request.log.debug(
          { user_sub, app_slug },
          'resolve-v2: user has no grants in app — return empty (không leak app existence)',
        );
        // Vẫn trả 200 với empty roles/permissions thay 403/404 — chống oracle attack (attacker biết user không có grant)
        // Cần epoch → fetch từ app row
        const appEpoch = await getAppEpoch(writerPool, app_slug);
        if (appEpoch === null) {
          return reply.status(404).send({ error: 'App not found', app_slug });
        }
        return reply.send({
          user_sub,
          app_slug,
          tenant_id,
          effective_roles: [],
          permissions: [],
          epoch: appEpoch,
          cached: false,
        });
      }

      // Fetch epoch first (nhanh, cache-friendly) để build cache key
      const appEpoch = await getAppEpoch(writerPool, app_slug);
      if (appEpoch === null) {
        return reply.status(404).send({ error: 'App not found', app_slug });
      }

      // Try Redis cache first
      const cached = await getCachedResolveV2(app_slug, user_sub, tenant_id, appEpoch);
      if (cached) {
        request.log.debug({ user_sub, app_slug, tenant_id, epoch: appEpoch }, 'resolve-v2: cache hit');
        return reply.send({
          user_sub,
          app_slug,
          tenant_id,
          effective_roles: cached.effective_roles,
          permissions: cached.permissions,
          epoch: cached.epoch,
          cached: true,
        });
      }

      // Cache miss — resolve from DB
      try {
        const result = await resolvePermissionsV2(writerPool, user_sub, app_slug, tenant_id);
        await setCachedResolveV2(app_slug, user_sub, tenant_id, result);

        return reply.send({
          user_sub,
          app_slug,
          tenant_id,
          effective_roles: result.effective_roles,
          permissions: result.permissions,
          epoch: result.epoch,
          cached: false,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('App not found')) {
          return reply.status(404).send({ error: msg });
        }
        request.log.error({ err, user_sub, app_slug }, 'resolve-v2: resolve failed');
        return reply.status(500).send({ error: 'Internal resolve error' });
      }
    },
  );
}
