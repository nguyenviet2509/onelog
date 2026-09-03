/**
 * routes/user-provision-config.ts — Read-only config the create-user dialog
 * needs before showing the form: password policy (drives realtime strength
 * checklist) + smtp_enabled (drives invite_email radio state).
 *
 * GET /v1/users/config
 *   Auth: verifyJwt (any admin JWT is fine — no secrets in response).
 *   Response: { smtp_enabled, password_policy }
 */
import type { FastifyInstance } from 'fastify';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { getPasswordPolicy } from '../lib/zitadel-password-policy-client.js';
import { config } from '../config.js';

export async function userProvisionConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/users/config',
    { preHandler: [verifyJwt] },
    async (request, reply) => {
      const rawQuery = request.query as Record<string, string> | undefined;
      const orgId = rawQuery?.['org_id'] ?? config.ZITADEL_ORG_ID;
      const password_policy = await getPasswordPolicy(orgId);
      return reply.send({
        smtp_enabled: config.ZITADEL_SMTP_ENABLED,
        password_policy,
      });
    },
  );
}
