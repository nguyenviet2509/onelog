/**
 * routes/health.ts — GET /v1/health
 * Checks writer + auditor DB connections. Redis stubbed for Phase 2.
 * Exposes audit_write_failures in-process counter (Phase 2: replace with prom-client).
 */
import type { FastifyInstance } from 'fastify';
import { checkWriterConnection } from '../db/writer-pool.js';
import { checkAuditorConnection } from '../db/auditor-pool.js';
import { getAuditWriteFailures } from '../lib/audit-metrics.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/health', async (_request, reply) => {
    const [writer, auditor] = await Promise.all([
      checkWriterConnection(),
      checkAuditorConnection(),
    ]);

    const auditFailures = getAuditWriteFailures();
    const ok = writer && auditor;
    const status = ok ? 200 : 503;

    return reply.status(status).send({
      status: ok ? 'ok' : 'degraded',
      checks: {
        db_writer: writer ? 'ok' : 'fail',
        db_auditor: auditor ? 'ok' : 'fail',
        redis: 'stubbed', // Phase 2
        audit_write_failures: auditFailures,
      },
      ts: new Date().toISOString(),
    });
  });
}
