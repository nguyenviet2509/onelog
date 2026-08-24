/**
 * routes/resolve.ts — POST /v1/resolve
 * Flattens permissions for a set of role keys via recursive CTE.
 * Mandatory auth: X-Rbac-Token OR zitadel-signature (F4 fix).
 * Phase 2: Redis cache with epoch versioning + singleflight dedup.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { verifyResolveAuth } from '../middleware/auth-resolve.js';
import { resolvePermissions } from '../db/queries/resolve.js';
import { getResolveEpoch } from '../db/queries/resolve-epoch.js';
import { writerPool } from '../db/writer-pool.js';
import { redis } from '../lib/redis-client.js';
import { singleflight } from '../lib/singleflight.js';
import { resolveBodySchema } from '../schemas/resolve-schemas.js';
import { logger } from '../lib/logger.js';

const RESOLVE_CACHE_TTL_S = 15 * 60; // 15 min

export async function resolveRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/resolve',
    { preHandler: [verifyResolveAuth] },
    async (request, reply) => {
      const parsed = resolveBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation error',
          details: parsed.error.issues,
        });
      }

      const { roles } = parsed.data;

      // Build cache key: resolve:v{epoch}:{sha256(sorted_roles)}
      const epoch = await getResolveEpoch(writerPool);
      const sortedRoles = [...roles].sort();
      const rolesHash = createHash('sha256').update(sortedRoles.join(',')).digest('hex');
      const cacheKey = `resolve:v${epoch}:${rolesHash}`;

      // Try Redis cache first
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          logger.debug({ cacheKey }, 'resolve: cache hit');
          const parsed = JSON.parse(cached) as {
            permissions: string[];
            roles_expanded: string[];
            permissions_hash: string;
          };
          return reply.send({ ...parsed, cached: true, epoch });
        }
      } catch (err) {
        logger.warn({ err, cacheKey }, 'resolve: Redis get failed — falling through to DB');
      }

      // Cache miss — singleflight guards stampede
      const result = await singleflight(cacheKey, async () => {
        const dbResult = await resolvePermissions(writerPool, roles);
        const sorted = [...dbResult.permissions].sort();
        const permissions_hash = createHash('sha256').update(sorted.join(',')).digest('hex');
        return {
          permissions: sorted,
          roles_expanded: dbResult.roles_expanded,
          permissions_hash,
        };
      });

      // Write to Redis (non-blocking on error)
      try {
        await redis.setex(cacheKey, RESOLVE_CACHE_TTL_S, JSON.stringify(result));
        // Also store hash→perms mapping for /v1/permissions-lookup
        await redis.setex(
          `perm-hash:${result.permissions_hash}`,
          RESOLVE_CACHE_TTL_S,
          JSON.stringify(result.permissions),
        );
      } catch (err) {
        logger.warn({ err, cacheKey }, 'resolve: Redis setex failed — result not cached');
      }

      return reply.send({ ...result, cached: false, epoch });
    },
  );
}
