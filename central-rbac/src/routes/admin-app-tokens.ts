/**
 * routes/admin-app-tokens.ts — Per-app token CRUD for admin.
 *
 * POST   /v1/admin/apps/:slug/tokens  — create + one-time reveal
 * GET    /v1/admin/apps/:slug/tokens  — list (prefix + metadata, no secret)
 * DELETE /v1/admin/apps/:slug/tokens/:id — soft-revoke + cache invalidate
 *
 * Chain: verifyJwt → requireAdmin → handler
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { writeAuditLog } from '../middleware/audit-log.js';
import { writerPool } from '../db/writer-pool.js';
import { createAppToken, listAppTokens, revokeAppToken } from '../services/app-token-service.js';
import { resolveUserDisplayNames } from '../lib/zitadel-event-enrichment.js';
import { config } from '../config.js';

const createBody = z.object({
  label: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9-]+$/, 'lowercase alphanumeric + dash'),
});

const slugParam = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/, 'slug must start with letter, lowercase alphanumeric + dash');

const tokenIdParam = z.string().uuid('token id must be a UUID');

async function getAppIdBySlug(slug: string): Promise<string | null> {
  const { rows } = await writerPool.query<{ id: string }>(
    `SELECT id FROM rbac.apps WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  return rows[0]?.id ?? null;
}

export async function registerAdminAppTokensRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/admin/apps/:slug/tokens
  app.post(
    '/v1/admin/apps/:slug/tokens',
    { preHandler: [verifyJwt, requireAdmin] },
    async (request, reply) => {
      const slugCheck = slugParam.safeParse((request.params as { slug: string }).slug);
      if (!slugCheck.success) {
        return reply.status(400).send({ error: 'invalid_slug', details: slugCheck.error.flatten() });
      }
      const body = createBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
      }

      const appId = await getAppIdBySlug(slugCheck.data);
      if (!appId) return reply.status(404).send({ error: 'app_not_found' });

      try {
        const created = await createAppToken({
          appId,
          label: body.data.label,
          createdBy: request.jwtClaims!.sub!,
        });

        await writeAuditLog(request, {
          action: 'app_token.create',
          target_type: 'app_token',
          target_id: created.id,
          after_state: {
            app_id: appId,
            app_slug: slugCheck.data,
            label: created.label,
            prefix: created.prefix,
          },
        });

        return reply.status(201).send({
          id: created.id,
          prefix: created.prefix,
          label: created.label,
          token: created.fullToken,
          warning: 'Copy this token now. It will not be shown again.',
        });
      } catch (err: unknown) {
        // Postgres unique_violation
        if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23505') {
          return reply.status(409).send({ error: 'label_already_active' });
        }
        throw err;
      }
    },
  );

  // GET /v1/admin/apps/:slug/tokens
  app.get(
    '/v1/admin/apps/:slug/tokens',
    { preHandler: [verifyJwt, requireAdmin] },
    async (request, reply) => {
      const slugCheck = slugParam.safeParse((request.params as { slug: string }).slug);
      if (!slugCheck.success) {
        return reply.status(400).send({ error: 'invalid_slug' });
      }
      const appId = await getAppIdBySlug(slugCheck.data);
      if (!appId) return reply.status(404).send({ error: 'app_not_found' });

      const tokens = await listAppTokens(appId);
      // Enrich created_by / revoked_by with Zitadel display_name (Redis-cached 24h).
      const userIds = tokens.flatMap((t) => [t.created_by, t.revoked_by].filter((x): x is string => !!x));
      const nameMap = await resolveUserDisplayNames(userIds, config.ZITADEL_ORG_ID);
      return reply.send({
        tokens: tokens.map((t) => ({
          id: t.id,
          prefix: t.token_prefix,
          label: t.label,
          created_at: t.created_at,
          created_by: t.created_by,
          created_by_name: nameMap.get(t.created_by) ?? null,
          last_used_at: t.last_used_at,
          revoked_at: t.revoked_at,
          revoked_by: t.revoked_by,
          revoked_by_name: t.revoked_by ? (nameMap.get(t.revoked_by) ?? null) : null,
          status: t.revoked_at ? 'revoked' : 'active',
        })),
      });
    },
  );

  // DELETE /v1/admin/apps/:slug/tokens/:id
  app.delete(
    '/v1/admin/apps/:slug/tokens/:id',
    { preHandler: [verifyJwt, requireAdmin] },
    async (request, reply) => {
      const params = request.params as { slug: string; id: string };
      const slugCheck = slugParam.safeParse(params.slug);
      const idCheck = tokenIdParam.safeParse(params.id);
      if (!slugCheck.success) return reply.status(400).send({ error: 'invalid_slug' });
      if (!idCheck.success) return reply.status(400).send({ error: 'invalid_token_id' });

      const appId = await getAppIdBySlug(slugCheck.data);
      if (!appId) return reply.status(404).send({ error: 'app_not_found' });

      const revoked = await revokeAppToken(idCheck.data, request.jwtClaims!.sub!);
      if (!revoked) {
        return reply.status(404).send({ error: 'token_not_found_or_already_revoked' });
      }

      await writeAuditLog(request, {
        action: 'app_token.revoke',
        target_type: 'app_token',
        target_id: idCheck.data,
        after_state: { app_id: appId, app_slug: slugCheck.data },
      });

      return reply.send({ ok: true });
    },
  );
}
