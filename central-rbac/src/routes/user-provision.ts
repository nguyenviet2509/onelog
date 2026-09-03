/**
 * routes/user-provision.ts — Phase 02 admin user lifecycle proxy.
 *
 * POST   /v1/users                  — create human user (Zitadel + invite email)
 * POST   /v1/users/:id/deactivate   — block new logins (existing sessions stay valid)
 * POST   /v1/users/:id/reactivate   — unblock login
 *
 * Auth chain on every route: verifyJwt → requireAdmin (rbac.admin).
 * Every mutation writes an audit log entry for compliance trail.
 *
 * Password/MFA reset, deletion, and session revoke stay with Zitadel's
 * self-service / Console — see plan Non-goals.
 */
import type { FastifyInstance } from 'fastify';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { writeAuditLog } from '../middleware/audit-log.js';
import {
  createHumanUser,
  deactivateUser,
  reactivateUser,
  deleteUser,
} from '../lib/zitadel-user-provision-client.js';
import { createUserBodySchema, userIdParamSchema } from '../schemas/user-schemas.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export async function userProvisionRoutes(app: FastifyInstance): Promise<void> {
  const adminGate = { preHandler: [verifyJwt, requireAdmin] };

  // POST /v1/users — create human user + trigger invite email
  app.post('/v1/users', adminGate, async (request, reply) => {
    const parsed = createUserBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
    }

    const body = parsed.data;
    const orgId = body.org_id ?? config.ZITADEL_ORG_ID;
    if (!orgId) {
      return reply.status(400).send({ error: 'org_id required (ZITADEL_ORG_ID not set as default)' });
    }

    // Guard: invite_email mode is disabled until Zitadel SMTP is wired for INET
    // (see plan 260903-...). Reject with a clear message rather than silent fail.
    if (body.mode === 'invite_email' && !config.ZITADEL_SMTP_ENABLED) {
      return reply.status(400).send({
        error: 'SMTP chưa cấu hình — chọn mode "set_password" hoặc "setup_later"',
      });
    }

    try {
      const result = await createHumanUser({
        email: body.email,
        firstName: body.first_name,
        lastName: body.last_name,
        displayName: body.display_name,
        orgId,
        mode: body.mode,
        password: body.password,
        passwordChangeRequired: body.password_change_required,
        preferredLanguage: body.preferred_language,
      });

      await writeAuditLog(request, {
        action: 'user.create',
        target_type: 'user',
        target_id: result.userId,
        after_state: {
          email: body.email,
          org_id: orgId,
          mode: body.mode,
          already_existed: result.alreadyExisted,
        },
      });

      return reply.status(result.alreadyExisted ? 200 : 201).send({
        id: result.userId,
        email: body.email,
        already_existed: result.alreadyExisted,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, email: body.email }, 'user-provision: create failed');
      return reply.status(502).send({ error: 'Failed to create user', detail: msg });
    }
  });

  // POST /v1/users/:id/deactivate — block new logins
  app.post('/v1/users/:id/deactivate', adminGate, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid user id' });

    const rawBody = (request.body ?? {}) as { org_id?: string };
    const orgId = rawBody.org_id ?? config.ZITADEL_ORG_ID;
    if (!orgId) return reply.status(400).send({ error: 'org_id required' });

    try {
      await deactivateUser(params.data.id, orgId);
      await writeAuditLog(request, {
        action: 'user.deactivate',
        target_type: 'user',
        target_id: params.data.id,
        after_state: { org_id: orgId },
      });
      return reply.send({ id: params.data.id, state: 'inactive' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, user_id: params.data.id }, 'user-provision: deactivate failed');
      return reply.status(502).send({ error: 'Failed to deactivate user', detail: msg });
    }
  });

  // DELETE /v1/users/:id — hard delete user in Zitadel (cascades grants + sessions)
  app.delete('/v1/users/:id', adminGate, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid user id' });

    const rawBody = (request.body ?? {}) as { org_id?: string };
    const orgId = rawBody.org_id ?? config.ZITADEL_ORG_ID;
    if (!orgId) return reply.status(400).send({ error: 'org_id required' });

    try {
      await deleteUser(params.data.id, orgId);
      await writeAuditLog(request, {
        action: 'user.delete',
        target_type: 'user',
        target_id: params.data.id,
        before_state: { org_id: orgId },
      });
      return reply.send({ id: params.data.id, deleted: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, user_id: params.data.id }, 'user-provision: delete failed');
      return reply.status(502).send({ error: 'Failed to delete user', detail: msg });
    }
  });

  // POST /v1/users/:id/reactivate — restore login
  app.post('/v1/users/:id/reactivate', adminGate, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid user id' });

    const rawBody = (request.body ?? {}) as { org_id?: string };
    const orgId = rawBody.org_id ?? config.ZITADEL_ORG_ID;
    if (!orgId) return reply.status(400).send({ error: 'org_id required' });

    try {
      await reactivateUser(params.data.id, orgId);
      await writeAuditLog(request, {
        action: 'user.reactivate',
        target_type: 'user',
        target_id: params.data.id,
        after_state: { org_id: orgId },
      });
      return reply.send({ id: params.data.id, state: 'active' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, user_id: params.data.id }, 'user-provision: reactivate failed');
      return reply.status(502).send({ error: 'Failed to reactivate user', detail: msg });
    }
  });
}
