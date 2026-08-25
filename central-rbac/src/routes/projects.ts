/**
 * routes/projects.ts — /v1/projects endpoint for Central RBAC UI.
 *
 * GET /v1/projects — returns project list for grant dialog.
 *
 * MVP: hardcoded single-project response using ZITADEL_PROJECT_ID env.
 * YAGNI: UI only has 1 project in review scope; full project search deferred post-review.
 *
 * Auth: verifyJwt.
 */
import type { FastifyInstance } from 'fastify';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { config } from '../config.js';

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/projects
   * Returns: { data: [{ id, name }] }
   */
  app.get('/v1/projects', { preHandler: [verifyJwt] }, async (_request, reply) => {
    const projectId = config.ZITADEL_PROJECT_ID;

    // Return empty list if not configured — UI falls back to its own MVP_FALLBACK
    if (!projectId) {
      return reply.send({ data: [] });
    }

    return reply.send({
      data: [{ id: projectId, name: 'central-rbac' }],
    });
  });
}
