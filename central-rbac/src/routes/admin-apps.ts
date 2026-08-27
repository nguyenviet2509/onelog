/**
 * routes/admin-apps.ts — Phase 07 Admin Single-Pane Wizard.
 *
 * POST /v1/admin/apps
 *   Body: { name, slug, callback_urls[], manifest_url? }
 *   Chain: verifyJwt → rateLimitAdmin → handler
 *   Flow:
 *     1. Validate body (zod)
 *     2. Slug regex + prefix-collision guard (Fix #13)
 *     3. Check pending_cleanups for reclaim opportunity (Fix #8)
 *     4. Zitadel SearchProjects → 409 if exists
 *     5. Zitadel AddProject → AddOIDCApp (transactional-ish)
 *     6. On AddOIDCApp fail → RemoveProject; if THAT fails → INSERT pending_cleanups
 *     7. On success → INSERT rbac.apps + create 3 default roles + writeAuditLog
 *     8. Return {project_id, client_id, client_secret} — ONE-TIME reveal
 *
 * GET /v1/admin/apps
 *   List all registered apps (no secrets).
 *
 * Rate limit: 5/24h per admin, 20/24h global (Fix #11).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { rateLimitAdmin } from '../middleware/rate-limit-admin.js';
import { writeAuditLog } from '../middleware/audit-log.js';
import { writerPool } from '../db/writer-pool.js';
import { addProject, findProjectByName, removeProject } from '../lib/zitadel-project-client.js';
import { addOidcApp } from '../lib/zitadel-oidc-app-client.js';
import { logger } from '../lib/logger.js';

// Slug: kebab-case, 3-32 chars, must start with letter (Fix #13)
const SLUG_REGEX = /^[a-z][a-z0-9-]{2,31}$/;

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().regex(SLUG_REGEX, 'slug must match ^[a-z][a-z0-9-]{2,31}$'),
  callback_urls: z.array(z.string().url().startsWith('https://')).min(1).max(10),
  manifest_url: z
    .string()
    .url()
    .startsWith('https://', 'manifest_url must be HTTPS')
    .optional(),
});

interface DbApp {
  id: string;
  slug: string;
  name: string;
  zitadel_project_id: string | null;
  zitadel_client_id: string | null;
  manifest_url: string | null;
  created_at: string;
  created_by: string;
}

/**
 * Check slug prefix collision (Fix #13).
 * Reject if new slug is a prefix of, or has as prefix, any existing slug.
 * Case-insensitive.
 */
async function checkSlugCollision(slug: string): Promise<string | null> {
  const s = slug.toLowerCase();
  const { rows } = await writerPool.query<{ slug: string }>(
    `SELECT slug FROM rbac.apps
     WHERE lower(slug) = $1
        OR lower(slug) LIKE $2
        OR $1 LIKE (lower(slug) || '%')
     LIMIT 1`,
    [s, `${s}%`],
  );
  if (rows.length === 0) return null;
  const existing = rows[0]?.slug;
  if (existing === s) return `slug '${slug}' already exists`;
  return `slug '${slug}' collides with existing slug '${existing}' (prefix rule)`;
}

async function checkReclaim(name: string): Promise<{ id: string; project_id: string } | null> {
  const { rows } = await writerPool.query<{
    id: string;
    zitadel_project_id: string;
  }>(
    `SELECT id, zitadel_project_id
       FROM rbac.pending_cleanups
      WHERE project_name = $1
      LIMIT 1`,
    [name],
  );
  const r = rows[0];
  return r ? { id: r.id, project_id: r.zitadel_project_id } : null;
}

async function insertPendingCleanup(
  projectId: string,
  projectName: string,
  clientId: string | null,
  adminSub: string,
  errorMsg: string,
): Promise<void> {
  await writerPool.query(
    `INSERT INTO rbac.pending_cleanups
       (zitadel_project_id, project_name, zitadel_client_id, admin_sub, last_error, attempt_count, next_retry_at)
     VALUES ($1, $2, $3, $4, $5, 1, now() + interval '60 seconds')`,
    [projectId, projectName, clientId, adminSub, errorMsg],
  );
}

async function insertApp(
  slug: string,
  name: string,
  projectId: string,
  clientId: string,
  manifestUrl: string | null,
  adminSub: string,
): Promise<DbApp> {
  const { rows } = await writerPool.query<DbApp>(
    `INSERT INTO rbac.apps
       (slug, name, zitadel_project_id, zitadel_client_id, manifest_url, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, slug, name, zitadel_project_id, zitadel_client_id, manifest_url, created_at, created_by`,
    [slug, name, projectId, clientId, manifestUrl, adminSub],
  );
  if (!rows[0]) throw new Error('INSERT rbac.apps returned no rows');
  return rows[0];
}

async function createDefaultRoles(appSlug: string, adminSub: string): Promise<void> {
  const roles = ['viewer', 'editor', 'admin'];
  for (const suffix of roles) {
    const key = `${appSlug}.${suffix}`;
    await writerPool.query(
      `INSERT INTO rbac.roles (key, description)
       VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, `Default ${suffix} role for app ${appSlug}`],
    );
  }
  logger.info({ app_slug: appSlug, admin: adminSub }, 'admin-apps: created 3 default roles');
}

export async function adminAppsRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/admin/apps — wizard endpoint
  app.post(
    '/v1/admin/apps',
    {
      preHandler: [verifyJwt, rateLimitAdmin({ scope: 'admin_app_create' })],
    },
    async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
      }
      const { name, slug, callback_urls, manifest_url } = parsed.data;
      const adminSub = request.jwtClaims!.sub!;

      // (2) Slug + prefix-collision guard
      const collision = await checkSlugCollision(slug);
      if (collision) return reply.status(409).send({ error: collision });

      // (3) Reclaim check — offer if orphan project matches name
      const reclaim = await checkReclaim(name);
      if (reclaim) {
        return reply.status(409).send({
          error: 'Orphan project found — reclaim required',
          reclaim: { pending_cleanup_id: reclaim.id, zitadel_project_id: reclaim.project_id },
        });
      }

      // (4) Zitadel-side SearchProjects
      const existing = await findProjectByName(name).catch((err: unknown) => {
        logger.error({ err }, 'admin-apps: SearchProjects failed');
        return null;
      });
      if (existing) {
        return reply.status(409).send({
          error: `Project name '${name}' already exists in Zitadel`,
          zitadel_project_id: existing.id,
        });
      }

      // (5) AddProject
      let projectId: string;
      try {
        const result = await addProject(name);
        projectId = result.id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, name }, 'admin-apps: AddProject failed');
        return reply.status(502).send({ error: 'Zitadel AddProject failed', detail: msg });
      }

      // (6) AddOIDCApp — on failure: RemoveProject, else pending_cleanups
      let clientId: string;
      let clientSecret: string;
      try {
        const oidcResult = await addOidcApp({
          projectId,
          name,
          redirectUris: callback_urls,
        });
        clientId = oidcResult.clientId;
        clientSecret = oidcResult.clientSecret;
      } catch (oidcErr) {
        const oidcMsg = oidcErr instanceof Error ? oidcErr.message : String(oidcErr);
        logger.error({ err: oidcMsg, project_id: projectId }, 'admin-apps: AddOIDCApp failed — rolling back');

        // Attempt RemoveProject rollback
        try {
          await removeProject(projectId);
          logger.info({ project_id: projectId }, 'admin-apps: rollback RemoveProject OK');
        } catch (rbErr) {
          const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
          logger.error(
            { err: rbMsg, project_id: projectId },
            'admin-apps: rollback failed → queuing pending_cleanups',
          );
          await insertPendingCleanup(projectId, name, null, adminSub, `${oidcMsg} | rollback: ${rbMsg}`);
        }

        return reply.status(502).send({ error: 'Zitadel AddOIDCApp failed', detail: oidcMsg });
      }

      // (7) INSERT rbac.apps + default roles + audit
      const newApp = await insertApp(slug, name, projectId, clientId, manifest_url ?? null, adminSub);
      await createDefaultRoles(slug, adminSub);
      await writeAuditLog(request, {
        action: 'app.create',
        target_type: 'app',
        target_id: newApp.id,
        after_state: {
          slug,
          name,
          zitadel_project_id: projectId,
          zitadel_client_id: clientId,
          manifest_url: manifest_url ?? null,
        },
      });

      // (8) One-time reveal
      return reply.status(201).send({
        id: newApp.id,
        slug,
        name,
        zitadel_project_id: projectId,
        client_id: clientId,
        client_secret: clientSecret,
        warning: 'client_secret shown once — store it now; cannot be retrieved again',
      });
    },
  );

  // GET /v1/admin/apps — list all apps (no secrets)
  app.get(
    '/v1/admin/apps',
    { preHandler: [verifyJwt] },
    async (_request, reply) => {
      const { rows } = await writerPool.query<DbApp>(
        `SELECT id, slug, name, zitadel_project_id, zitadel_client_id, manifest_url, created_at, created_by
           FROM rbac.apps
          ORDER BY created_at DESC`,
      );
      return reply.send({ apps: rows });
    },
  );
}
