/**
 * routes/resolve.ts — POST /v1/resolve
 * Flattens permissions for a set of role keys via recursive CTE.
 * Mandatory auth: X-Rbac-Token OR zitadel-signature (F4 fix).
 */
import type { FastifyInstance } from 'fastify';
import { verifyResolveAuth } from '../middleware/auth-resolve.js';
import { resolvePermissions } from '../db/queries/resolve.js';
import { writerPool } from '../db/writer-pool.js';
import { resolveBodySchema } from '../schemas/resolve-schemas.js';

export async function resolveRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/resolve',
    { preHandler: [verifyResolveAuth] },
    async (request, reply) => {
      const parsed = resolveBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation error',
          details: parsed.error.issues,
        });
      }

      const { roles } = parsed.data;
      const result = await resolvePermissions(writerPool, roles);

      return reply.send({
        permissions: result.permissions,
        roles_expanded: result.roles_expanded,
        cached: false, // Phase 2: Redis cache
      });
    },
  );
}
