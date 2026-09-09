/**
 * routes/permissions-lookup.ts — Hash-based permissions reverse lookup.
 *
 * GET /v1/permissions-lookup?hash=<sha256_hex>
 *
 * Consumer apps (e.g. OneMCP) receive a `permissions_hash` claim in the JWT.
 * They call this endpoint with the hash to get the full permissions[] array.
 *
 * Redis key: perm-hash:{hash} → JSON-serialized string[]
 * Keys are seeded by the resolve route (POST /v1/resolve) on every cache write.
 * TTL: 5min (300s) — aligned with resolve cache TTL (Phase 2: 15min resolve,
 * but hash lookup is consumer-side so shorter TTL is safe).
 *
 * JWT auth required. No mutation — read-only lookup.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { redis } from '../lib/redis-client.js';
import { logger } from '../lib/logger.js';

function permHashKey(hash: string): string {
  return `perm-hash:${hash}`;
}

export async function permissionsLookupRoutes(app: FastifyInstance): Promise<void> {
  const hashQuerySchema = z.object({
    hash: z.string().regex(/^[0-9a-f]{64}$/, 'hash must be 64-char hex (SHA-256)'),
  });

  app.get('/v1/permissions-lookup', { preHandler: [verifyJwt] }, async (request, reply) => {
    const parsed = hashQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
    }

    const { hash } = parsed.data;
    const key = permHashKey(hash);

    let cached: string | null = null;
    try {
      cached = await redis.get(key);
    } catch (err) {
      logger.warn({ err, hash }, 'permissions-lookup: Redis get failed — returning 503');
      return reply.status(503).send({ error: 'Cache unavailable — retry shortly' });
    }

    if (!cached) {
      logger.info({ hash }, 'permissions-lookup: hash not found in cache');
      return reply.status(404).send({
        error: 'Permissions hash not found',
        hint: 'Hash expires after 5min. Re-authenticate to refresh.',
      });
    }

    let permissions: string[];
    try {
      permissions = JSON.parse(cached) as string[];
    } catch {
      logger.error({ hash }, 'permissions-lookup: corrupt cache value — evicting');
      await redis.del(key).catch(() => {});
      return reply.status(500).send({ error: 'Corrupt cache entry evicted — retry' });
    }

    logger.debug({ hash, count: permissions.length }, 'permissions-lookup: cache hit');
    return reply.send({ hash, permissions });
  });
}
