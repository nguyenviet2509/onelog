/**
 * routes/admin-oidc-config.ts — Retrofit endpoint for OIDC apps not created
 * via the Phase 07 wizard (e.g. central-rbac's own OIDC client bootstrapped
 * by hand). Forces the 3 assertion flags to true so ID tokens carry profile
 * claims required by the admin UI (fix for the "User 798148" bug seen on
 * 2026-08-27).
 *
 * POST /v1/admin/oidc-config/ensure
 *   Body: { zitadel_project_id, zitadel_org_id? }
 *   Auth: rbac.admin (see require-admin.ts).
 *   Idempotent — apps already conformant land in `skipped: [{reason: 'already-ok'}]`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { writeAuditLog } from '../middleware/audit-log.js';
import { ensureAssertionFlags } from '../lib/zitadel-oidc-app-client.js';
import { logger } from '../lib/logger.js';

const bodySchema = z.object({
  zitadel_project_id: z.string().min(1),
  zitadel_org_id: z.string().min(1).optional(),
});

export async function adminOidcConfigRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/admin/oidc-config/ensure',
    { preHandler: [verifyJwt, requireAdmin] },
    async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
      }
      const { zitadel_project_id, zitadel_org_id } = parsed.data;

      try {
        const result = await ensureAssertionFlags(zitadel_project_id, zitadel_org_id);
        await writeAuditLog(request, {
          action: 'oidc.ensure_assertion_flags',
          target_type: 'zitadel_project',
          target_id: zitadel_project_id,
          after_state: {
            updated_count: result.updated.length,
            updated: result.updated,
            skipped_count: result.skipped.length,
          },
        });
        return reply.send(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, zitadel_project_id }, 'admin-oidc-config: ensure failed');
        return reply.status(502).send({ error: 'Failed to ensure OIDC assertion flags', detail: msg });
      }
    },
  );
}
