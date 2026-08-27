/**
 * routes/projects.ts — /v1/projects endpoint for Central RBAC UI.
 *
 * GET /v1/projects — returns registered apps as projects for the grant dialog.
 *
 * Post-wizard rewrite: query rbac.apps (populated by wizard + backfill), enrich
 * each project with owner org (name from Redis-cached Zitadel getOrgById).
 * Legacy env-only fallback (ZITADEL_PROJECT_ID) prepended when no apps registered
 * so grant dialog still works during first-time setup.
 *
 * Auth: verifyJwt.
 */
import type { FastifyInstance } from 'fastify';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { config } from '../config.js';
import { writerPool } from '../db/writer-pool.js';
import { getOrgsBatch } from '../lib/zitadel-org-client.js';

interface AppRow {
  id: string;
  slug: string;
  name: string;
  zitadel_project_id: string | null;
  zitadel_org_id: string | null;
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/projects
   * Returns: { data: [{ id, name, slug, app_id, org: {id, name} | null }] }
   */
  app.get('/v1/projects', { preHandler: [verifyJwt] }, async (_request, reply) => {
    const { rows } = await writerPool.query<AppRow>(
      `SELECT id, slug, name, zitadel_project_id, zitadel_org_id
         FROM rbac.apps
        WHERE zitadel_project_id IS NOT NULL
        ORDER BY name ASC`,
    );

    const orgMap = await getOrgsBatch(rows.map((r) => r.zitadel_org_id));

    const data = rows.map((r) => ({
      id: r.zitadel_project_id!,
      name: r.name,
      slug: r.slug,
      app_id: r.id,
      org: (r.zitadel_org_id && orgMap.get(r.zitadel_org_id)) || null,
    }));

    // Legacy fallback: if no apps registered yet, expose env project so grant
    // dialog still works during first-time setup.
    if (data.length === 0 && config.ZITADEL_PROJECT_ID) {
      data.push({
        id: config.ZITADEL_PROJECT_ID,
        name: 'central-rbac',
        slug: 'central-rbac',
        app_id: '',
        org: null,
      });
    }

    return reply.send({ data });
  });
}
