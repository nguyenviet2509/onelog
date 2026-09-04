/**
 * routes/projects.ts — /v1/projects endpoint for Central RBAC UI (grant dialog).
 *
 * Post multi-org rewrite (2026-09-04): sources from Zitadel Admin API
 * (listAllProjectsAcrossOrgs) so grant dialog can pick projects across every
 * org, not just the SA's default org. Each project is joined against
 * rbac.apps (via zitadel_project_id) so the UI can filter roles by app_id.
 *
 * Fallback: if Zitadel is unreachable OR SA lacks IAM_OWNER, we return the
 * rbac.apps rows the way pre-multi-org code did so the grant dialog still
 * works during degraded operation.
 *
 * Auth: verifyJwt.
 */
import type { FastifyInstance } from 'fastify';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { config } from '../config.js';
import { writerPool } from '../db/writer-pool.js';
import { getOrgsBatch } from '../lib/zitadel-org-client.js';
import { listAllProjectsAcrossOrgs } from '../lib/zitadel-project-client.js';
import { logger } from '../lib/logger.js';

interface AppRow {
  id: string;
  slug: string;
  name: string;
  zitadel_project_id: string | null;
  zitadel_org_id: string | null;
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/projects', { preHandler: [verifyJwt] }, async (_request, reply) => {
    // 1. Local rbac.apps → map by zitadel_project_id for app_id lookup
    const { rows: appRows } = await writerPool.query<AppRow>(
      `SELECT id, slug, name, zitadel_project_id, zitadel_org_id
         FROM rbac.apps
        WHERE zitadel_project_id IS NOT NULL`,
    );
    const appByProject = new Map(appRows.map((r) => [r.zitadel_project_id!, r]));

    // 2. Live Zitadel across all orgs
    let projectsFromZitadel: Awaited<ReturnType<typeof listAllProjectsAcrossOrgs>> = [];
    try {
      projectsFromZitadel = await listAllProjectsAcrossOrgs();
    } catch (err) {
      logger.warn({ err }, '/v1/projects: Zitadel cross-org fetch failed → falling back to rbac.apps');
    }

    // 3. Build response — prefer Zitadel source when available
    let data: Array<{
      id: string;
      name: string;
      slug: string | null;
      app_id: string | null;
      org: { id: string; name: string } | null;
    }>;

    if (projectsFromZitadel.length > 0) {
      data = projectsFromZitadel.map((p) => {
        const app = appByProject.get(p.id) ?? null;
        return {
          id: p.id,
          name: app?.name ?? p.name,
          slug: app?.slug ?? null,
          app_id: app?.id ?? null,
          org: { id: p.orgId, name: p.orgName },
        };
      });
      // Stable sort: registered first, then by org name, then project name
      data.sort((a, b) => {
        const aReg = a.app_id ? 0 : 1;
        const bReg = b.app_id ? 0 : 1;
        if (aReg !== bReg) return aReg - bReg;
        const orgCmp = (a.org?.name ?? '').localeCompare(b.org?.name ?? '');
        if (orgCmp !== 0) return orgCmp;
        return a.name.localeCompare(b.name);
      });
    } else {
      // Fallback: rbac.apps only
      const orgMap = await getOrgsBatch(appRows.map((r) => r.zitadel_org_id));
      data = appRows
        .filter((r) => !!r.zitadel_project_id)
        .map((r) => ({
          id: r.zitadel_project_id!,
          name: r.name,
          slug: r.slug,
          app_id: r.id,
          org: (r.zitadel_org_id && orgMap.get(r.zitadel_org_id)) || null,
        }));
    }

    // Legacy env-only fallback for cold-start / first setup
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
