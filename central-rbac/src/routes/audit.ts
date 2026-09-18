/**
 * routes/audit.ts — GET /v1/audit
 * Query audit log with filters. Uses auditor pool (SELECT-only).
 *
 * Auth model (plan 260918-1308 Phase 03):
 * - GET /v1/audit (no filter): admin-only (cross-app)
 * - GET /v1/audit?app_id=X: admin OR (member AND owner của app X)
 * - GET /v1/audit/apps: admin-only (facet dropdown)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { requireMember, isAdmin } from '../middleware/require-admin-or-owner.js';
import { auditorPool } from '../db/auditor-pool.js';
import { writerPool } from '../db/writer-pool.js';
import { redis } from '../lib/redis-client.js';
import { logger } from '../lib/logger.js';
import { queryAuditLog, countAuditLog, listAuditAppFacets } from '../db/queries/audit.js';

const APP_OWNERSHIP_CACHE_TTL = 300; // 5min

/** Cache-backed check: `apps.id` owned by `sub`. */
async function isAppOwner(appId: string, sub: string): Promise<boolean> {
  const key = `app-owner:${appId}:${sub}`;
  try {
    const cached = await redis.get(key);
    if (cached !== null) return cached === '1';
  } catch {
    /* redis down — fall through to DB */
  }
  const { rows } = await writerPool.query<{ ok: boolean }>(
    `SELECT (created_by = $2) AS ok FROM rbac.apps WHERE id = $1`,
    [appId, sub],
  );
  const ok = rows[0]?.ok === true;
  redis.setex(key, APP_OWNERSHIP_CACHE_TTL, ok ? '1' : '0').catch(() => {});
  return ok;
}

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
    { preHandler: [verifyJwt, requireMember] },
    async (request, reply) => {
      const parsed = auditQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
      }

      // Non-admin: must specify app_id AND own it.
      if (!isAdmin(request)) {
        const { app_id } = parsed.data;
        const sub = request.jwtClaims?.sub;
        if (!app_id || !sub) {
          logger.warn({ sub, app_id }, 'audit: non-admin missing app_id filter');
          return reply.status(403).send({ error: 'Forbidden — app_id required for non-admin' });
        }
        if (!(await isAppOwner(app_id, sub))) {
          logger.warn({ sub, app_id }, 'audit: non-admin not owner of app_id');
          return reply.status(403).send({ error: 'Forbidden — not app owner' });
        }
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
    { preHandler: [verifyJwt, requireAdmin] },
    async (_request, reply) => {
      const apps = await listAuditAppFacets(auditorPool);
      return reply.send({ apps });
    },
  );
}
