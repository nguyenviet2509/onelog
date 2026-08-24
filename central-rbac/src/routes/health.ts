/**
 * routes/health.ts — GET /v1/health
 * Checks writer DB, auditor DB, and Redis connections.
 * Exposes audit_write_failures in-process counter (Phase 3: replace with prom-client).
 */
import type { FastifyInstance } from 'fastify';
import { checkWriterConnection } from '../db/writer-pool.js';
import { checkAuditorConnection } from '../db/auditor-pool.js';
import { checkRedisConnection } from '../lib/redis-client.js';
import { getAuditWriteFailures } from '../lib/audit-metrics.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/health', async (_request, reply) => {
    const [writer, auditor, redisOk] = await Promise.all([
      checkWriterConnection(),
      checkAuditorConnection(),
      checkRedisConnection(),
    ]);

    const auditFailures = getAuditWriteFailures();
    // Redis degraded is non-fatal — app still works without cache (slower)
    const ok = writer && auditor;
    const status = ok ? 200 : 503;

    return reply.status(status).send({
      status: ok ? 'ok' : 'degraded',
      checks: {
        db_writer: writer ? 'ok' : 'fail',
        db_auditor: auditor ? 'ok' : 'fail',
        redis: redisOk ? 'ok' : 'degraded',
        audit_write_failures: auditFailures,
      },
      ts: new Date().toISOString(),
    });
  });
}
