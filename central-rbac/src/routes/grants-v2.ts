/**
 * routes/grants-v2.ts — Delegation grants endpoints.
 * Phase 09 (plan 260910-1334) Phase 4.
 *
 * POST   /v2/apps/:slug/grants                 — assign role với can_grant check
 * DELETE /v2/apps/:slug/grants/:grant_id       — revoke với reverse can_grant check
 *
 * KEY DIFF từ v1 /v1/assignments:
 *   - Central-side user_grants là source of truth (không query Zitadel để check)
 *   - Delegation enforcement qua can_grant (v1 chỉ có admin-only)
 *   - Tenant scope aware (tenant_id NULL = global, string = scoped)
 *   - notify_app_revoke enqueue (parity với v1 flow, commit aa1e1e8 2026-09-09)
 *
 * Auth: verifyJwt (admin flow — grantor identity từ JWT sub).
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { requireAdminOrAppOwner } from '../middleware/require-admin-or-owner.js';
import { writeAuditLog } from '../middleware/audit-log.js';
import { writerPool } from '../db/writer-pool.js';
import { enqueueOutbox } from '../db/queries/outbox.js';
import { canAssignRoleAndInsert, canRevokeRole } from '../services/delegation-check.js';
import { logger } from '../lib/logger.js';

const SLUG_REGEX = /^[a-z][a-z0-9-]{2,31}$/;
const ROLE_KEY_REGEX = /^[a-z][a-z0-9-]{2,31}\.[a-z][a-z0-9]{1,31}$/;

const assignBodySchema = z.object({
  user_sub: z.string().min(1).max(256),
  role_key: z.string().regex(ROLE_KEY_REGEX),
  tenant_id: z.string().max(256).nullable().optional(),
});

const paramsSchema = z.object({
  slug: z.string().regex(SLUG_REGEX),
});

const grantParamsSchema = z.object({
  slug: z.string().regex(SLUG_REGEX),
  grant_id: z.string().uuid(),
});

export async function grantsV2Routes(app: FastifyInstance): Promise<void> {
  // ── POST /v2/apps/:slug/grants — assign role ─────────────────────────────
  app.post<{ Params: { slug: string } }>(
    '/v2/apps/:slug/grants',
    { preHandler: [verifyJwt, requireAdminOrAppOwner('slug')] },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'Invalid slug' });
      }
      const body = assignBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'Validation error', details: body.error.issues });
      }

      const grantorSub = request.jwtClaims!.sub!;
      const { user_sub: targetUserSub, role_key: targetRoleKey } = body.data;
      const targetTenantId = body.data.tenant_id ?? null;
      const appSlug = params.data.slug;

      let checkResult;
      try {
        checkResult = await canAssignRoleAndInsert(
          grantorSub,
          targetUserSub,
          targetRoleKey,
          targetTenantId,
          appSlug,
        );
      } catch (err) {
        logger.error({ err, grantorSub, targetUserSub, targetRoleKey, appSlug }, 'grants-v2: assign failed');
        return reply.status(500).send({ error: 'Internal error during delegation check' });
      }

      if (!checkResult.allow) {
        // Audit denied attempt (defense visibility)
        await writeAuditLog(request, {
          action: 'grant.assign.denied',
          target_type: 'user_grant',
          target_id: targetUserSub,
          after_state: {
            reason: checkResult.reason,
            target_role_key: targetRoleKey,
            target_tenant_id: targetTenantId,
            app_slug: appSlug,
            grantor_effective_roles: checkResult.grantorEffectiveRoles ?? [],
          },
        }).catch((err) => logger.warn({ err }, 'grants-v2: audit denied failed'));

        return reply.status(403).send({
          error: 'Delegation denied',
          reason: checkResult.reason,
        });
      }

      // Fetch app_id + user_grants app_id for outbox context
      const { rows: appRows } = await writerPool.query<{ id: string; zitadel_project_id: string | null }>(
        `SELECT id, zitadel_project_id FROM rbac.apps WHERE slug = $1`,
        [appSlug],
      );
      const appId = appRows[0]!.id;
      const projectId = appRows[0]!.zitadel_project_id;

      // Enqueue Zitadel outbox (add_or_update_user_grant) if app có Zitadel project
      // Outbox worker sẽ expand hierarchy (Phase 4 update) — với v1 backward-compat guard
      if (projectId) {
        const idempotencyKey = createHash('sha256')
          .update(`grant-v2:${appId}:${targetUserSub}:${targetRoleKey}:${targetTenantId ?? 'NULL'}`)
          .digest('hex')
          .slice(0, 64);

        await enqueueOutbox(
          writerPool,
          'add_user_grant',
          { userId: targetUserSub, projectId, roleKey: targetRoleKey },
          idempotencyKey,
          request.id,
        ).catch((err) => {
          logger.warn(
            { err, appSlug, targetUserSub, targetRoleKey },
            'grants-v2: outbox enqueue failed — Central grant OK, Zitadel sync retried later',
          );
        });
      }

      // Audit success với delegation_chain nested trong after_state (per Gap 3 fix)
      await writeAuditLog(request, {
        action: 'grant.assign',
        target_type: 'user_grant',
        target_id: checkResult.grantId!,
        after_state: {
          user_sub: targetUserSub,
          role_key: targetRoleKey,
          tenant_id: targetTenantId,
          app_slug: appSlug,
          delegation_chain: checkResult.delegationChain,
          grantor_effective_roles: checkResult.grantorEffectiveRoles,
          central_operator_bypass: checkResult.centralOperatorBypass === true,
        },
      });

      return reply.status(201).send({
        grant_id: checkResult.grantId,
        user_sub: targetUserSub,
        role_key: targetRoleKey,
        tenant_id: targetTenantId,
        app_slug: appSlug,
        delegation_chain: checkResult.delegationChain,
      });
    },
  );

  // ── DELETE /v2/apps/:slug/grants/:grant_id — revoke ──────────────────────
  app.delete<{ Params: { slug: string; grant_id: string } }>(
    '/v2/apps/:slug/grants/:grant_id',
    { preHandler: [verifyJwt, requireAdminOrAppOwner('slug')] },
    async (request, reply) => {
      const params = grantParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'Invalid slug or grant_id' });
      }

      const grantorSub = request.jwtClaims!.sub!;
      const { slug: appSlug, grant_id: grantId } = params.data;

      const client = await writerPool.connect();
      try {
        await client.query('BEGIN');

        // Load grant + verify belongs to app
        const grantRes = await client.query<{
          user_sub: string;
          app_id: string;
          role_key: string;
          tenant_id: string | null;
        }>(
          `SELECT ug.user_sub, ug.app_id, ug.role_key, ug.tenant_id
             FROM rbac.user_grants ug
             JOIN rbac.apps a ON a.id = ug.app_id
            WHERE ug.id = $1 AND a.slug = $2
            FOR UPDATE`,
          [grantId, appSlug],
        );

        if (grantRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.status(404).send({ error: 'Grant not found' });
        }
        const grant = grantRes.rows[0]!;

        // Reverse delegation check
        const checkResult = await canRevokeRole(grantorSub, grant.role_key, grant.app_id, grant.tenant_id, client);
        if (!checkResult.allow) {
          await client.query('ROLLBACK');
          await writeAuditLog(request, {
            action: 'grant.revoke.denied',
            target_type: 'user_grant',
            target_id: grantId,
            after_state: {
              reason: checkResult.reason,
              role_key: grant.role_key,
              app_slug: appSlug,
            },
          }).catch((err) => logger.warn({ err }, 'grants-v2: audit revoke denied failed'));

          return reply.status(403).send({ error: 'Delegation denied', reason: checkResult.reason });
        }

        // DELETE (trigger will bump epoch)
        await client.query(`DELETE FROM rbac.user_grants WHERE id = $1`, [grantId]);
        await client.query('COMMIT');

        // notify_app_revoke outbox (parity với v1 flow — Gap 1 fix)
        const { rows: appRows } = await writerPool.query<{ revoke_url: string | null }>(
          `SELECT revoke_url FROM rbac.apps WHERE id = $1`,
          [grant.app_id],
        );
        if (appRows[0]?.revoke_url) {
          const timeBucket = Math.floor(Date.now() / 10_000).toString();
          const notifyIdemKey = createHash('sha256')
            .update(`notify_app_revoke:${grant.app_id}:${grant.user_sub}:${timeBucket}`)
            .digest('hex')
            .slice(0, 64);
          await enqueueOutbox(
            writerPool,
            'notify_app_revoke',
            { appId: grant.app_id, userId: grant.user_sub },
            notifyIdemKey,
            request.id,
          ).catch((err) => {
            logger.warn({ err, appId: grant.app_id, userId: grant.user_sub }, 'grants-v2: notify_app_revoke enqueue failed');
          });
        }

        await writeAuditLog(request, {
          action: 'grant.revoke',
          target_type: 'user_grant',
          target_id: grantId,
          before_state: {
            user_sub: grant.user_sub,
            role_key: grant.role_key,
            tenant_id: grant.tenant_id,
            app_slug: appSlug,
          },
        });

        return reply.status(200).send({
          revoked: true,
          grant_id: grantId,
          user_sub: grant.user_sub,
          role_key: grant.role_key,
          tenant_id: grant.tenant_id,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error({ err, grantorSub, grantId, appSlug }, 'grants-v2: revoke failed');
        return reply.status(500).send({ error: 'Internal error during revoke' });
      } finally {
        client.release();
      }
    },
  );
}
