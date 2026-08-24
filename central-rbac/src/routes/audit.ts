/**
 * routes/audit.ts — GET /v1/audit
 * Query audit log with filters. Uses auditor pool (SELECT-only).
 * Protected by JWT auth.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { auditorPool } from '../db/auditor-pool.js';
import { queryAuditLog } from '../db/queries/audit.js';

const auditQuerySchema = z.object({
  actor_id: z.string().optional(),
  action: z.string().optional(),
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

      const rows = await queryAuditLog(auditorPool, parsed.data);
      return reply.send({ data: rows, count: rows.length });
    },
  );
}
