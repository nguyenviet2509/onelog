/**
 * routes/audit.ts — GET /v1/audit
 * Query audit log with filters. Uses auditor pool (SELECT-only).
 * Protected by JWT auth.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { auditorPool } from '../db/auditor-pool.js';
import { queryAuditLog, countAuditLog, listAuditAppFacets } from '../db/queries/audit.js';

const auditQuerySchema = z.object({
  actor_id: z.string().optional(),
  action: z.string().optional(),
  app_id: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/audit',
    { preHandler: [verifyJwt] },
    async (request, reply) => {
      const parsed = auditQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
      }

      // Parallel: page rows + total count (same WHERE clause) for pagination UI.
      const [rows, total] = await Promise.all([
        queryAuditLog(auditorPool, parsed.data),
        countAuditLog(auditorPool, parsed.data),
      ]);
      return reply.send({ data: rows, count: rows.length, total });
    },
  );

  // Facets endpoint: distinct app_id values present in audit_log for the filter dropdown.
  // NULL bucket (internal rbac events) is returned as app_id=null so the UI can label it.
  app.get(
    '/v1/audit/apps',
    { preHandler: [verifyJwt] },
    async (_request, reply) => {
      const apps = await listAuditAppFacets(auditorPool);
      return reply.send({ apps });
    },
  );
}
