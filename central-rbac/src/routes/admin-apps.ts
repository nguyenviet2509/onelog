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
import { requireAdmin } from '../middleware/require-admin.js';
import { rateLimitAdmin } from '../middleware/rate-limit-admin.js';
import { writeAuditLog } from '../middleware/audit-log.js';
import { writerPool } from '../db/writer-pool.js';
import { addProject, findProjectByName, removeProject, listAllProjectsAcrossOrgs } from '../lib/zitadel-project-client.js';
import { getOrgsBatch } from '../lib/zitadel-org-client.js';
import {
  addOidcApp,
  findOidcAppByProject,
  patchOidcAppConfig,
  classifyClientType,
  isPublicClient,
  type ClientType,
} from '../lib/zitadel-oidc-app-client.js';
import { ZitadelHttpError } from '../lib/zitadel-http-error.js';
import { createRoleWithSync } from '../services/role-sync.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

// Slug: kebab-case, 3-32 chars, must start with letter (Fix #13)
const SLUG_REGEX = /^[a-z][a-z0-9-]{2,31}$/;

const CLIENT_TYPE_ENUM = z.enum(['web', 'spa', 'native']);

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().regex(SLUG_REGEX, 'slug must match ^[a-z][a-z0-9-]{2,31}$'),
  callback_urls: z.array(z.string().url().startsWith('https://')).min(1).max(10),
  post_logout_urls: z
    .array(z.string().url().startsWith('https://'))
    .max(10)
    .optional(),
  manifest_url: z
    .string()
    .url()
    .startsWith('https://', 'manifest_url must be HTTPS')
    .optional(),
  client_type: CLIENT_TYPE_ENUM.optional().default('web'),
});

const patchBodySchema = z
  .object({
    client_type: CLIENT_TYPE_ENUM.optional(),
    callback_urls: z.array(z.string().url().startsWith('https://')).min(1).max(10).optional(),
    post_logout_urls: z.array(z.string().url().startsWith('https://')).max(10).optional(),
  })
  .refine(
    (v) => v.client_type !== undefined || v.callback_urls !== undefined || v.post_logout_urls !== undefined,
    { message: 'at least one of client_type, callback_urls, post_logout_urls required' },
  );

interface DbApp {
  id: string;
  slug: string;
  name: string;
  zitadel_project_id: string | null;
  zitadel_client_id: string | null;
  manifest_url: string | null;
  created_at: string;
  created_by: string;
  client_type?: ClientType;
  zitadel_org_id?: string | null;
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
  zitadelOrgId: string,
  clientType: ClientType,
): Promise<DbApp> {
  const { rows } = await writerPool.query<DbApp>(
    `INSERT INTO rbac.apps
       (slug, name, zitadel_project_id, zitadel_org_id, zitadel_client_id, manifest_url, created_by, client_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, slug, name, zitadel_project_id, zitadel_client_id, manifest_url, created_at, created_by, client_type`,
    [slug, name, projectId, zitadelOrgId, clientId, manifestUrl, adminSub, clientType],
  );
  if (!rows[0]) throw new Error('INSERT rbac.apps returned no rows');
  return rows[0];
}

/**
 * Create 3 default roles ({slug}.viewer/editor/admin) + enqueue Zitadel sync.
 * Migration 011: sets role.app_id → wizard-created app so grant flow routes
 * to the NEW app's Zitadel project (not env ZITADEL_PROJECT_ID).
 * Fix for Phase 08 e2e discovery: outbox add_user_grant landed 'dead' because
 * roleKey did not exist in the target Zitadel project.
 */
async function createDefaultRoles(
  appSlug: string,
  appId: string,
  zitadelProjectId: string,
  adminSub: string,
): Promise<void> {
  const roles = ['viewer', 'editor', 'admin'];
  for (const suffix of roles) {
    const key = `${appSlug}.${suffix}`;
    const description = `Default ${suffix} role for app ${appSlug}`;

    // Skip if already exists (idempotent — wizard may be retried)
    const existing = await writerPool.query<{ id: string }>(
      `SELECT id FROM rbac.roles WHERE key = $1`,
      [key],
    );
    if (existing.rows.length > 0) {
      logger.info({ key, admin: adminSub }, 'admin-apps: role exists, skipping create+sync');
      continue;
    }

    try {
      await createRoleWithSync(
        { key, description, app_id: appId },
        undefined,
        zitadelProjectId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, key }, 'admin-apps: createRoleWithSync failed');
      throw err;
    }
  }
  logger.info(
    { app_slug: appSlug, app_id: appId, zitadel_project_id: zitadelProjectId, admin: adminSub },
    'admin-apps: created 3 default roles + enqueued Zitadel sync',
  );
}

export async function adminAppsRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/admin/apps — wizard endpoint
  app.post(
    '/v1/admin/apps',
    {
      preHandler: [verifyJwt, requireAdmin, rateLimitAdmin({ scope: 'admin_app_create' })],
    },
    async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
      }
      const { name, slug, callback_urls, post_logout_urls, manifest_url, client_type } = parsed.data;
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
          postLogoutRedirectUris: post_logout_urls,
          clientType: client_type,
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
      // Wizard always creates project under SA's default org (env ZITADEL_ORG_ID).
      // If future multi-org needed, extract from addProject response details.resourceOwner.
      const projectOrgId = config.ZITADEL_ORG_ID ?? '';
      const newApp = await insertApp(slug, name, projectId, clientId, manifest_url ?? null, adminSub, projectOrgId, client_type);
      await createDefaultRoles(slug, newApp.id, projectId, adminSub);
      await writeAuditLog(request, {
        action: 'app.create',
        target_type: 'app',
        target_id: newApp.id,
        after_state: {
          slug,
          name,
          client_type,
          zitadel_project_id: projectId,
          zitadel_client_id: clientId,
          manifest_url: manifest_url ?? null,
        },
      });

      // (8) One-time reveal — public clients (spa/native) receive no meaningful secret
      const publicClient = isPublicClient(client_type);
      return reply.status(201).send({
        id: newApp.id,
        slug,
        name,
        client_type,
        zitadel_project_id: projectId,
        client_id: clientId,
        ...(publicClient
          ? {
              note: 'Public client (PKCE) — no client_secret. Configure your app to use PKCE flow.',
            }
          : {
              client_secret: clientSecret,
              warning: 'client_secret shown once — store it now; cannot be retrieved again',
            }),
      });
    },
  );

  // GET /v1/admin/apps — list all registered apps + all Zitadel projects across
  // orgs. Unregistered Zitadel projects appear with `registered: false` and
  // null slug/id so the UI can visually distinguish. This makes the apps page
  // a single-pane view of every project regardless of which org owns it.
  //
  // Fallback: if Zitadel is unreachable (e.g. SA lacks IAM_OWNER), the
  // response degrades to rbac.apps only — same behaviour as pre-multi-org.
  app.get(
    '/v1/admin/apps',
    { preHandler: [verifyJwt, requireAdmin] },
    async (_request, reply) => {
      interface AppOut {
        id: string | null;
        slug: string | null;
        name: string;
        client_type: ClientType | null;
        zitadel_project_id: string | null;
        zitadel_client_id: string | null;
        zitadel_org_id: string | null;
        org_name: string | null;
        manifest_url: string | null;
        created_at: string | null;
        created_by: string | null;
        registered: boolean;
      }

      const { rows: dbApps } = await writerPool.query<DbApp & { zitadel_org_id: string | null; client_type: ClientType }>(
        `SELECT id, slug, name, client_type, zitadel_project_id, zitadel_org_id, zitadel_client_id,
                manifest_url, created_at, created_by
           FROM rbac.apps
          ORDER BY created_at DESC`,
      );
      const appByProject = new Map(
        dbApps.filter((a) => !!a.zitadel_project_id).map((a) => [a.zitadel_project_id!, a]),
      );

      let zitadelProjects: Awaited<ReturnType<typeof listAllProjectsAcrossOrgs>> = [];
      try {
        zitadelProjects = await listAllProjectsAcrossOrgs();
      } catch (err) {
        logger.warn({ err }, '/v1/admin/apps: Zitadel cross-org fetch failed → falling back to rbac.apps');
      }

      let apps: AppOut[];

      if (zitadelProjects.length > 0) {
        const seenProjects = new Set<string>();
        apps = zitadelProjects.map((p) => {
          seenProjects.add(p.id);
          const db = appByProject.get(p.id) ?? null;
          return {
            id: db?.id ?? null,
            slug: db?.slug ?? null,
            name: db?.name ?? p.name,
            client_type: db?.client_type ?? null,
            zitadel_project_id: p.id,
            zitadel_client_id: db?.zitadel_client_id ?? null,
            zitadel_org_id: p.orgId,
            org_name: p.orgName,
            manifest_url: db?.manifest_url ?? null,
            created_at: db?.created_at ?? null,
            created_by: db?.created_by ?? null,
            registered: !!db,
          };
        });
        // Registered rbac.apps rows without a matching Zitadel project (e.g.
        // project was manually deleted in Zitadel Console) — surface as
        // registered but flag missing project via null zitadel_project_id.
        for (const a of dbApps) {
          if (a.zitadel_project_id && !seenProjects.has(a.zitadel_project_id)) {
            apps.push({
              id: a.id,
              slug: a.slug,
              name: a.name,
              client_type: a.client_type,
              zitadel_project_id: a.zitadel_project_id,
              zitadel_client_id: a.zitadel_client_id,
              zitadel_org_id: a.zitadel_org_id,
              org_name: null,
              manifest_url: a.manifest_url,
              created_at: a.created_at,
              created_by: a.created_by,
              registered: true,
            });
          }
        }
        // Sort: registered first, then by org name, then project name
        apps.sort((a, b) => {
          if (a.registered !== b.registered) return a.registered ? -1 : 1;
          const orgCmp = (a.org_name ?? '').localeCompare(b.org_name ?? '');
          if (orgCmp !== 0) return orgCmp;
          return a.name.localeCompare(b.name);
        });
      } else {
        // Fallback: rbac.apps only (with org name enrichment)
        const orgMap = await getOrgsBatch(dbApps.map((a) => a.zitadel_org_id));
        apps = dbApps.map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          client_type: a.client_type,
          zitadel_project_id: a.zitadel_project_id,
          zitadel_client_id: a.zitadel_client_id,
          zitadel_org_id: a.zitadel_org_id,
          org_name: (a.zitadel_org_id && orgMap.get(a.zitadel_org_id)?.name) || null,
          manifest_url: a.manifest_url,
          created_at: a.created_at,
          created_by: a.created_by,
          registered: true,
        }));
      }

      return reply.send({ apps });
    },
  );

  // GET /v1/admin/apps/:slug/oidc-config — fetch live OIDC config from Zitadel
  // for the Edit App page. rbac.apps is metadata-only (client_type cached); URLs
  // live in Zitadel as source of truth so we don't drift on manual edits.
  app.get(
    '/v1/admin/apps/:slug/oidc-config',
    { preHandler: [verifyJwt, requireAdmin] },
    async (request, reply) => {
      const paramsSchema = z.object({ slug: z.string().regex(SLUG_REGEX) });
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) return reply.status(400).send({ error: 'Invalid slug' });
      const { slug } = parsedParams.data;

      const { rows } = await writerPool.query<{
        id: string;
        slug: string;
        name: string;
        client_type: ClientType;
        zitadel_project_id: string | null;
        zitadel_org_id: string | null;
        zitadel_client_id: string | null;
      }>(
        `SELECT id, slug, name, client_type, zitadel_project_id, zitadel_org_id, zitadel_client_id
           FROM rbac.apps WHERE slug = $1`,
        [slug],
      );
      const dbApp = rows[0];
      if (!dbApp) return reply.status(404).send({ error: 'App not found' });
      if (!dbApp.zitadel_project_id) {
        return reply.status(409).send({ error: 'App has no Zitadel project (orphan row)' });
      }

      const targetOrg = dbApp.zitadel_org_id || config.ZITADEL_ORG_ID || '';
      let oidcApp: Awaited<ReturnType<typeof findOidcAppByProject>>;
      try {
        oidcApp = await findOidcAppByProject(dbApp.zitadel_project_id, targetOrg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, slug, project_id: dbApp.zitadel_project_id }, 'admin-apps: fetch OIDC app failed');
        return reply.status(502).send({ error: 'Zitadel fetch failed', detail: msg });
      }
      if (!oidcApp || !oidcApp.oidcConfig) {
        return reply.status(404).send({ error: 'OIDC app not found in Zitadel project' });
      }

      const cfg = oidcApp.oidcConfig;
      // Prefer live Zitadel-derived type — DB value may lag if admin edited via Zitadel Console
      const liveType = classifyClientType(cfg);
      return reply.send({
        slug: dbApp.slug,
        name: dbApp.name,
        zitadel_project_id: dbApp.zitadel_project_id,
        zitadel_org_id: dbApp.zitadel_org_id,
        zitadel_client_id: dbApp.zitadel_client_id,
        oidc_app_id: oidcApp.id,
        client_type: liveType,
        client_type_db: dbApp.client_type,
        callback_urls: cfg.redirectUris ?? [],
        post_logout_urls: cfg.postLogoutRedirectUris ?? [],
        additional_origins: cfg.additionalOrigins ?? [],
      });
    },
  );

  // PATCH /v1/admin/apps/:slug — sửa client_type + callback URLs + post-logout URLs
  // Merge-then-PUT against Zitadel (preserve accessTokenType, assertions, etc.)
  // Auto-derives additionalOrigins from final redirectUris.
  app.patch(
    '/v1/admin/apps/:slug',
    { preHandler: [verifyJwt, requireAdmin] },
    async (request, reply) => {
      const paramsSchema = z.object({ slug: z.string().regex(SLUG_REGEX) });
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) return reply.status(400).send({ error: 'Invalid slug' });
      const parsedBody = patchBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({ error: 'Validation error', details: parsedBody.error.issues });
      }
      const { slug } = parsedParams.data;
      const { client_type: nextType, callback_urls, post_logout_urls } = parsedBody.data;

      const { rows } = await writerPool.query<{
        id: string;
        client_type: ClientType;
        zitadel_project_id: string | null;
        zitadel_org_id: string | null;
      }>(
        `SELECT id, client_type, zitadel_project_id, zitadel_org_id
           FROM rbac.apps WHERE slug = $1`,
        [slug],
      );
      const dbApp = rows[0];
      if (!dbApp) return reply.status(404).send({ error: 'App not found' });
      if (!dbApp.zitadel_project_id) {
        return reply.status(409).send({ error: 'App has no Zitadel project (orphan row)' });
      }

      const targetOrg = dbApp.zitadel_org_id || config.ZITADEL_ORG_ID || '';

      // Serialize concurrent PATCH on same app via Postgres advisory lock (same
      // pattern as outbox-processor.ts). Zitadel Mgmt API lacks ETag/If-Match, so
      // merge-then-PUT races silently overwrite. Lock held for duration of
      // fetch→PUT→DB update to guarantee atomic semantics per app.
      const lockClient = await writerPool.connect();
      let patched: Awaited<ReturnType<typeof patchOidcAppConfig>>;
      try {
        await lockClient.query('BEGIN');
        await lockClient.query(
          `SELECT pg_advisory_xact_lock(hashtext($1))`,
          [`app-patch:${dbApp.id}`],
        );

        let oidcApp: Awaited<ReturnType<typeof findOidcAppByProject>>;
        try {
          oidcApp = await findOidcAppByProject(dbApp.zitadel_project_id, targetOrg);
        } catch (err) {
          await lockClient.query('ROLLBACK').catch(() => {});
          const msg = err instanceof Error ? err.message : String(err);
          return reply.status(502).send({ error: 'Zitadel fetch failed', detail: msg });
        }
        if (!oidcApp) {
          await lockClient.query('ROLLBACK').catch(() => {});
          return reply.status(404).send({ error: 'OIDC app not found in Zitadel project' });
        }

        try {
          patched = await patchOidcAppConfig({
            projectId: dbApp.zitadel_project_id,
            appId: oidcApp.id,
            targetOrgId: targetOrg,
            clientType: nextType,
            redirectUris: callback_urls,
            postLogoutRedirectUris: post_logout_urls,
          });
        } catch (err) {
          await lockClient.query('ROLLBACK').catch(() => {});
          if (err instanceof ZitadelHttpError && err.status === 400) {
            return reply.status(400).send({ error: err.message });
          }
          if (err instanceof ZitadelHttpError && err.status === 404) {
            return reply.status(404).send({ error: err.message });
          }
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err: msg, slug }, 'admin-apps: patch OIDC config failed');
          return reply.status(502).send({ error: 'Zitadel patch failed', detail: msg });
        }

        // Sync DB.client_type only if it changed (avoid pointless UPDATE + audit noise)
        if (patched.clientType !== dbApp.client_type) {
          await lockClient.query(
            `UPDATE rbac.apps SET client_type = $1 WHERE id = $2`,
            [patched.clientType, dbApp.id],
          );
        }

        await lockClient.query('COMMIT');
      } catch (err) {
        await lockClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        lockClient.release();
      }

      await writeAuditLog(request, {
        action: 'app.patch',
        target_type: 'app',
        target_id: dbApp.id,
        before_state: { client_type: dbApp.client_type },
        after_state: {
          client_type: patched.clientType,
          callback_urls: patched.redirectUris,
          post_logout_urls: patched.postLogoutRedirectUris,
          additional_origins: patched.additionalOrigins,
        },
      });

      return reply.send({
        slug,
        client_type: patched.clientType,
        callback_urls: patched.redirectUris,
        post_logout_urls: patched.postLogoutRedirectUris,
        additional_origins: patched.additionalOrigins,
      });
    },
  );

  // DELETE /v1/admin/apps/:id — remove Zitadel project + rbac.apps row + linked roles
  // Order: Zitadel remove (source of truth for grants) → DB cleanup → audit.
  // If Zitadel remove fails: DB untouched, admin can retry. If DB fails after
  // Zitadel success: orphan roles remain (harmless — roles.app_id ON DELETE SET NULL).
  app.delete(
    '/v1/admin/apps/:id',
    { preHandler: [verifyJwt, requireAdmin] },
    async (request, reply) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const parsed = paramsSchema.safeParse(request.params);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid app id' });
      const appId = parsed.data.id;

      const { rows: existing } = await writerPool.query<DbApp>(
        `SELECT id, slug, name, zitadel_project_id, zitadel_client_id, manifest_url, created_at, created_by
           FROM rbac.apps WHERE id = $1`,
        [appId],
      );
      const app = existing[0];
      if (!app) return reply.status(404).send({ error: 'App not found' });

      if (app.zitadel_project_id) {
        try {
          await removeProject(app.zitadel_project_id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err: msg, app_id: appId, project_id: app.zitadel_project_id }, 'admin-apps: RemoveProject failed');
          return reply.status(502).send({ error: 'Zitadel RemoveProject failed', detail: msg });
        }
      }

      const client = await writerPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM rbac.roles WHERE app_id = $1`, [appId]);
        await client.query(`DELETE FROM rbac.apps  WHERE id = $1`, [appId]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, app_id: appId }, 'admin-apps: DB delete failed');
        return reply.status(500).send({ error: 'DB delete failed', detail: msg });
      } finally {
        client.release();
      }

      await writeAuditLog(request, {
        action: 'app.delete',
        target_type: 'app',
        target_id: appId,
        before_state: {
          slug: app.slug,
          name: app.name,
          zitadel_project_id: app.zitadel_project_id,
        },
      });

      return reply.send({ id: appId, deleted: true });
    },
  );
}
