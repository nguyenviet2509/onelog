/**
 * routes/epoch.ts — GET /v2/epoch/:app_slug
 *
 * Phase 09 (plan 260910-1334). Per-app epoch endpoint cho SDK poll (10s interval typical).
 * SDK gọi endpoint này định kỳ, so sánh epoch với cached — nếu khác → flush cache.
 *
 * Redis-first cache 5s TTL để giảm tải DB khi 1000+ SDK cùng poll.
 * Fail-through nếu Redis xuống — fetch DB trực tiếp.
 *
 * Auth: reuse verifyResolveAuth (X-Rbac-Token OR zitadel-signature).
 */
import type { FastifyInstance } from 'fastify';
import { verifyResolveAuth } from '../middleware/auth-resolve.js';
import { getAppEpoch } from '../db/queries/resolve-v2.js';
import { getCachedEpoch, setCachedEpoch } from '../lib/resolve-cache.js';
import { writerPool } from '../db/writer-pool.js';

const SLUG_REGEX = /^[a-z][a-z0-9-]{2,31}$/;

export async function epochRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { app_slug: string } }>(
    '/v2/epoch/:app_slug',
    { preHandler: [verifyResolveAuth] },
    async (request, reply) => {
      const { app_slug } = request.params;
      if (!SLUG_REGEX.test(app_slug)) {
        return reply.status(400).send({ error: 'Invalid app_slug format' });
      }

      // Try Redis cache first (5s TTL absorbs 1000+ concurrent polls)
      const cached = await getCachedEpoch(app_slug);
      if (cached !== null) {
        return reply.send({ app_slug, epoch: cached, cached: true });
      }

      // Cache miss — fetch DB
      const epoch = await getAppEpoch(writerPool, app_slug);
      if (epoch === null) {
        return reply.status(404).send({ error: 'App not found', app_slug });
      }

      await setCachedEpoch(app_slug, epoch);
      return reply.send({ app_slug, epoch, cached: false });
    },
  );
}
