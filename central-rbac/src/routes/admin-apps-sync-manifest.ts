/**
 * routes/admin-apps-sync-manifest.ts — Phase 08 manifest sync + apply endpoints.
 *
 * POST /v1/admin/apps/:id/sync-manifest       → fetch + diff
 * POST /v1/admin/apps/:id/apply-manifest-diff → apply approved diff (sha256-pinned)
 *
 * Red Team Fixes:
 *   #2  SSRF: manifest-fetcher enforces HTTPS + DNS pin + private-IP block
 *   #9  Implicit deprecate: 4-category diff, implicit-deprecate default UNCHECKED (UI concern)
 *   #13 Namespace exact-segment enforcement in manifest-diff.validateManifest
 *   #14 Sha256 TOCTOU pin: cache manifest body by sha256, apply looks up cached copy
 *
 * Cache: Redis TTL 1h keyed by `manifest:cache:${sha256}`.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import yaml from 'js-yaml';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { writeAuditLog } from '../middleware/audit-log.js';
import { writerPool } from '../db/writer-pool.js';
import { redis } from '../lib/redis-client.js';
import { fetchManifest } from '../services/manifest-fetcher.js';
import { validateManifest, computeDiff, type DiffAction } from '../services/manifest-diff.js';
import { enqueueOutbox } from '../db/queries/outbox.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/** Plan 260915-1615 phase 3: inline import guardrails.
 *  100KB caps paste-in DoS; larger manifests should still use manifest_url. */
const INLINE_MAX_BYTES = 100 * 1024;

/**
 * Upsert role linked to app + enqueue add_project_role Zitadel sync outbox on INSERT.
 *
 * KEY BEHAVIOR:
 *   - Sets `source='manifest'` on INSERT (was defaulting to 'manual' due to bug 2026-09-09).
 *   - On new INSERT (rowCount=1) → enqueue `add_project_role` outbox event so Zitadel
 *     Mgmt API creates the role in project (needed for user_grant HTTP 400 fix). Without
 *     this, user assignment fails permanently because Zitadel rejects grants for unknown
 *     roles.
 *   - On CONFLICT (role already exists) → no-op for Zitadel (assume idempotent from prior sync).
 *   - Uses same idempotency-key format as `role-sync.ts.createRoleWithSync()` so if
 *     admin already created role via wizard, outbox insert is idempotent (bump status to
 *     pending only, no duplicate Zitadel call).
 */
async function upsertManifestRole(
  client: PoolClient,
  appId: string,
  projectId: string,
  role: { key: string; description?: string; parent_key?: string | null; can_grant?: string[] },
): Promise<{ isNewRole: boolean }> {
  const description = role.description ?? `Role ${role.key} (from manifest)`;
  // v2 fields: parent_key + can_grant. v1 manifests don't declare these — leave existing
  // DB state untouched via defined? checks below. Only apply on v2 sync.
  const isV2 = role.parent_key !== undefined || role.can_grant !== undefined;
  const parentKey = role.parent_key ?? null;
  const canGrant = role.can_grant ?? [];

  const result = await client.query(
    isV2
      ? `INSERT INTO rbac.roles (key, description, app_id, source, parent_key, can_grant)
         VALUES ($1, $2, $3, 'manifest', $4, $5)
         ON CONFLICT (key) DO UPDATE SET
           app_id = COALESCE(rbac.roles.app_id, EXCLUDED.app_id),
           source = CASE WHEN rbac.roles.source = 'manual' THEN 'manifest' ELSE rbac.roles.source END,
           parent_key = EXCLUDED.parent_key,
           can_grant = EXCLUDED.can_grant`
      : `INSERT INTO rbac.roles (key, description, app_id, source)
         VALUES ($1, $2, $3, 'manifest')
         ON CONFLICT (key) DO UPDATE SET
           app_id = COALESCE(rbac.roles.app_id, EXCLUDED.app_id),
           source = CASE WHEN rbac.roles.source = 'manual' THEN 'manifest' ELSE rbac.roles.source END`,
    isV2 ? [role.key, description, appId, parentKey, canGrant] : [role.key, description, appId],
  );
  // rowCount=1 for INSERT (new row) or UPDATE (existing) — can't distinguish reliably from
  // rowCount alone. Instead: check if role existed BEFORE insert to decide Zitadel sync need.
  // Simpler: always enqueue idempotent outbox; enqueueOutbox de-dupes by idempotency_key.
  const idempotencyKey = createHash('sha256')
    .update(`add_project_role:${projectId}:${role.key}`)
    .digest('hex')
    .slice(0, 64);
  await enqueueOutbox(
    client,
    'add_project_role',
    { projectId, orgId: config.ZITADEL_ORG_ID || '', roleKey: role.key, displayName: description },
    idempotencyKey,
  );
  return { isNewRole: (result.rowCount ?? 0) > 0 };
}

const MANIFEST_CACHE_TTL_SEC = 60 * 60;

const paramsSchema = z.object({ id: z.string().uuid() });

const applyBodySchema = z.object({
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 hex chars'),
  approved_items: z
    .array(
      z.object({
        action: z.enum(['add', 'update-desc', 'explicit-deprecate', 'implicit-deprecate']),
        id: z.string(),
      }),
    )
    .min(0),
});

interface DbApp {
  id: string;
  slug: string;
  name: string;
  manifest_url: string | null;
  manifest_etag: string | null;
}

interface CachedManifest {
  sha256: string;
  service: string;
  raw: string;
  fetched_at: number;
}

async function loadApp(id: string): Promise<DbApp | null> {
  const { rows } = await writerPool.query<DbApp>(
    `SELECT id, slug, name, manifest_url, manifest_etag
       FROM rbac.apps
      WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function persistEtag(appId: string, etag: string | null): Promise<void> {
  await writerPool.query(
    `UPDATE rbac.apps SET manifest_etag = $2, last_synced_at = now() WHERE id = $1`,
    [appId, etag],
  );
}

/**
 * Auto-wire manifest.default_roles → rbac.role_permissions idempotently.
 * Skips role_permission pairs where target permission doesn't exist yet
 * (admin must apply-manifest-diff first to insert missing permissions).
 * Sets role.app_id link if not already set (Migration 011).
 * Returns count of pair rows actually INSERT'd this run.
 */
async function autoWireDefaultRoles(
  manifest: {
    default_roles?: Array<{
      key: string;
      description?: string;
      permissions: string[];
      parent_key?: string | null;
      can_grant?: string[];
    }>;
  },
  appId: string,
): Promise<number> {
  if (!manifest.default_roles || manifest.default_roles.length === 0) return 0;
  // Resolve Zitadel projectId for this app (Migration 011). Fallback env only for legacy apps.
  const { rows: appRows } = await writerPool.query<{ zitadel_project_id: string | null }>(
    `SELECT zitadel_project_id FROM rbac.apps WHERE id = $1`,
    [appId],
  );
  const projectId = appRows[0]?.zitadel_project_id ?? config.ZITADEL_PROJECT_ID;
  const client = await writerPool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;
    for (const role of manifest.default_roles) {
      // Ensure role row exists + linked to this app + source=manifest + Zitadel role synced
      // (2026-09-09 bug fix: was missing source + Zitadel sync → qlts.user assignment failed 400)
      await upsertManifestRole(client, appId, projectId, role);
      for (const permKey of role.permissions) {
        const result = await client.query(
          `INSERT INTO rbac.role_permissions (role_key, permission_key)
           SELECT $1, $2
           WHERE EXISTS (SELECT 1 FROM rbac.permissions WHERE key = $2 AND deprecated_at IS NULL)
           ON CONFLICT (role_key, permission_key) DO NOTHING`,
          [role.key, permKey],
        );
        inserted += result.rowCount ?? 0;
      }
    }
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function adminAppsSyncManifestRoutes(app: FastifyInstance): Promise<void> {
  // ── Sync (fetch + diff) ────────────────────────────────────────────────────
  app.post(
    '/v1/admin/apps/:id/sync-manifest',
    { preHandler: [verifyJwt] },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: 'Invalid app id' });

      const dbApp = await loadApp(params.data.id);
      if (!dbApp) return reply.status(404).send({ error: 'App not found' });
      if (!dbApp.manifest_url) {
        return reply.status(409).send({ error: 'App has no manifest_url — set it before syncing' });
      }

      // Fetch (SSRF-hardened) — pass If-None-Match if we have prev etag
      const fetchResult = await fetchManifest({
        url: dbApp.manifest_url,
        ...(dbApp.manifest_etag ? { ifNoneMatch: dbApp.manifest_etag } : {}),
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg, app_id: dbApp.id, url: dbApp.manifest_url }, 'sync-manifest: fetch failed');
        return { failure: msg };
      });

      if ('failure' in fetchResult) {
        return reply.status(502).send({ error: 'Manifest fetch failed', detail: fetchResult.failure });
      }

      if (fetchResult.status === 'not-modified') {
        return reply.send({ status: 'not-modified', etag: fetchResult.etag });
      }

      if (!fetchResult.bodyText || !fetchResult.sha256) {
        return reply.status(500).send({ error: 'fetcher returned fetched without body/sha256' });
      }

      // Validate
      const validation = await validateManifest(fetchResult.bodyText, dbApp.slug);
      if (!validation.ok) {
        return reply.status(400).send({ error: 'Manifest validation failed', errors: validation.errors });
      }

      // Cache body server-side keyed by sha256 (Fix #14 TOCTOU pin)
      const cache: CachedManifest = {
        sha256: fetchResult.sha256,
        service: validation.manifest.service,
        raw: fetchResult.bodyText,
        fetched_at: Date.now(),
      };
      await redis.setex(`manifest:cache:${fetchResult.sha256}`, MANIFEST_CACHE_TTL_SEC, JSON.stringify(cache));

      // Compute diff
      const diff = await computeDiff(validation.manifest);

      // Auto-wire manifest.default_roles → role_permissions idempotently at SYNC time.
      // Rationale: role_permission wiring doesn't require per-item admin approval; it's
      // metadata describing how declared roles map to declared permissions. If admin
      // wants to customize, they can adjust via /users grant dialog later.
      // Only wires (role_key, permission_key) pairs where permission already exists in DB
      // and isn't deprecated. New permissions still need apply() first.
      const rolePermsWired = await autoWireDefaultRoles(validation.manifest, dbApp.id);

      // Persist etag for next sync (fast path via 304)
      await persistEtag(dbApp.id, fetchResult.etag);

      // Audit — reuse audit_log hash chain (Fix #12)
      await writeAuditLog(request, {
        action: 'manifest.sync.fetch',
        target_type: 'app',
        target_id: dbApp.id,
        after_state: {
          sha256: fetchResult.sha256,
          etag: fetchResult.etag,
          counts: diff.counts,
          role_perms_wired: rolePermsWired,
        },
      });

      return reply.send({
        status: 'fetched',
        etag: fetchResult.etag,
        manifest_sha256: fetchResult.sha256,
        service: validation.manifest.service,
        version: validation.manifest.version,
        diff: { items: diff.items, counts: diff.counts },
      });
    },
  );

  // ── Apply (sha256-pinned) ──────────────────────────────────────────────────
  app.post(
    '/v1/admin/apps/:id/apply-manifest-diff',
    { preHandler: [verifyJwt] },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: 'Invalid app id' });
      const body = applyBodySchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: 'Invalid body', details: body.error.issues });

      const dbApp = await loadApp(params.data.id);
      if (!dbApp) return reply.status(404).send({ error: 'App not found' });

      // Look up cached manifest by sha256 (Fix #14)
      const cachedJson = await redis.get(`manifest:cache:${body.data.manifest_sha256}`);
      if (!cachedJson) {
        return reply
          .status(409)
          .send({ error: 'Manifest cache expired or invalid — re-sync required' });
      }
      const cached = JSON.parse(cachedJson) as CachedManifest;

      // Re-validate cached content against app slug (defense in depth).
      // skipSsrfCheck: apply flow uses cached body already SSRF-validated at sync time —
      // re-checking DNS wastes latency + could differ if DNS flapped (accept cached decision).
      const validation = await validateManifest(cached.raw, dbApp.slug, { skipSsrfCheck: true });
      if (!validation.ok) {
        return reply.status(500).send({ error: 'Cached manifest failed re-validation', errors: validation.errors });
      }
      const manifest = validation.manifest;

      // Recompute diff to build authoritative action set
      const currentDiff = await computeDiff(manifest);
      const approvedById = new Map(body.data.approved_items.map((it) => [`${it.action}:${it.id}`, it]));

      const appliedCounts: Record<DiffAction, number> = {
        add: 0, 'update-desc': 0, 'explicit-deprecate': 0, 'implicit-deprecate': 0,
      };

      const client = await writerPool.connect();
      try {
        await client.query('BEGIN');
        for (const item of currentDiff.items) {
          const key = `${item.action}:${item.id}`;
          if (!approvedById.has(key)) continue;

          if (item.action === 'add') {
            const inc = item.incoming!;
            await client.query(
              `INSERT INTO rbac.permissions (key, description, alias_of)
               VALUES ($1, $2, $3)
               ON CONFLICT (key) DO NOTHING`,
              [item.id, inc.description, inc.alias_of ?? null],
            );
            appliedCounts.add += 1;
          } else if (item.action === 'update-desc') {
            await client.query(
              `UPDATE rbac.permissions SET description = $2 WHERE key = $1`,
              [item.id, item.incoming!.description],
            );
            appliedCounts['update-desc'] += 1;
          } else if (item.action === 'explicit-deprecate') {
            await client.query(
              `UPDATE rbac.permissions
                  SET deprecated_at = now(), alias_of = COALESCE($2, alias_of)
                WHERE key = $1`,
              [item.id, item.incoming?.alias_of ?? null],
            );
            appliedCounts['explicit-deprecate'] += 1;
          } else if (item.action === 'implicit-deprecate') {
            await client.query(
              `UPDATE rbac.permissions SET deprecated_at = now() WHERE key = $1`,
              [item.id],
            );
            appliedCounts['implicit-deprecate'] += 1;
          }
        }
        // Wire manifest.default_roles → role_permissions (idempotent, ON CONFLICT DO NOTHING).
        // Only wires permissions that (a) exist in DB (either just-inserted or pre-existing),
        // (b) aren't deprecated, (c) belong to this app's namespace.
        // If admin later customizes a role, existing rows preserved (only new pairs INSERT'd).
        let rolePermsAdded = 0;
        if (manifest.default_roles && manifest.default_roles.length > 0) {
          // Resolve Zitadel projectId for this app once for the whole loop.
          const { rows: appRows } = await client.query<{ zitadel_project_id: string | null }>(
            `SELECT zitadel_project_id FROM rbac.apps WHERE id = $1`,
            [dbApp.id],
          );
          const projectId = appRows[0]?.zitadel_project_id ?? config.ZITADEL_PROJECT_ID;
          for (const role of manifest.default_roles) {
            // Ensure role row + source=manifest + Zitadel role sync (2026-09-09 fix — was missing).
            await upsertManifestRole(client, dbApp.id, projectId, role);
            for (const permKey of role.permissions) {
              const result = await client.query(
                `INSERT INTO rbac.role_permissions (role_key, permission_key)
                 SELECT $1, $2
                 WHERE EXISTS (SELECT 1 FROM rbac.permissions WHERE key = $2 AND deprecated_at IS NULL)
                 ON CONFLICT (role_key, permission_key) DO NOTHING`,
                [role.key, permKey],
              );
              rolePermsAdded += result.rowCount ?? 0;
            }
          }
        }
        await client.query('COMMIT');
        appliedCounts['add'] += rolePermsAdded;  // count role_permissions inserted under add
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, app_id: dbApp.id }, 'apply-manifest-diff: tx failed');
        return reply.status(500).send({ error: 'Apply transaction failed', detail: msg });
      } finally {
        client.release();
      }

      await writeAuditLog(request, {
        action: 'manifest.sync.apply',
        target_type: 'app',
        target_id: dbApp.id,
        after_state: {
          sha256: body.data.manifest_sha256,
          service: manifest.service,
          version: manifest.version,
          applied_counts: appliedCounts,
          approved_count: body.data.approved_items.length,
        },
      });

      return reply.send({ status: 'applied', applied_counts: appliedCounts });
    },
  );

  // ── Sync from inline JSON/YAML paste (plan 260915-1615 phase 3) ────────────
  // POST /v1/admin/apps/:id/sync-manifest-inline
  //   Body: { format: 'json' | 'yaml', content: string }
  // Bypass HTTP fetch — admin pastes manifest directly. Reuses validate + diff
  // pipeline, caches by sha256 so existing apply-manifest-diff endpoint works
  // unchanged. YAML parsed via js-yaml (safe schema — no custom tags).
  const inlineBodySchema = z.object({
    format: z.enum(['json', 'yaml']),
    content: z.string().min(1).max(INLINE_MAX_BYTES),
  });

  app.post(
    '/v1/admin/apps/:id/sync-manifest-inline',
    { preHandler: [verifyJwt] },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: 'Invalid app id' });

      const body = inlineBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'Invalid body', details: body.error.issues });
      }

      const dbApp = await loadApp(params.data.id);
      if (!dbApp) return reply.status(404).send({ error: 'App not found' });

      // Step 1: parse (YAML → JSON if needed). Yaml default schema safe: no custom
      // tags, no arbitrary code execution, billion-laughs bounded by content size cap.
      let parsedObject: unknown;
      try {
        if (body.data.format === 'yaml') {
          parsedObject = yaml.load(body.data.content, { schema: yaml.CORE_SCHEMA });
        } else {
          parsedObject = JSON.parse(body.data.content);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({
          error: `${body.data.format.toUpperCase()} parse failed`,
          detail: msg,
        });
      }

      // Step 2: canonicalize to JSON string. Ensures deterministic sha256 across
      // yaml/json input for the same logical manifest — apply endpoint uses sha256 lookup.
      const canonicalJson = JSON.stringify(parsedObject);
      const sha256 = createHash('sha256').update(canonicalJson).digest('hex');

      // Step 3: reuse validate + diff pipeline (v1/v2 dispatched inside).
      const validation = await validateManifest(canonicalJson, dbApp.slug);
      if (!validation.ok) {
        return reply.status(400).send({ error: 'Manifest validation failed', errors: validation.errors });
      }

      const cache: CachedManifest = {
        sha256,
        service: validation.manifest.service,
        raw: canonicalJson,
        fetched_at: Date.now(),
      };
      await redis.setex(`manifest:cache:${sha256}`, MANIFEST_CACHE_TTL_SEC, JSON.stringify(cache));

      const diff = await computeDiff(validation.manifest);

      // Auto-wire default_roles → role_permissions (same behavior as HTTP-fetched sync).
      const rolePermsWired = await autoWireDefaultRoles(validation.manifest, dbApp.id);

      await writeAuditLog(request, {
        action: 'manifest.sync.inline',
        target_type: 'app',
        target_id: dbApp.id,
        after_state: {
          sha256,
          format: body.data.format,
          counts: diff.counts,
          role_perms_wired: rolePermsWired,
        },
      });

      return reply.send({
        status: 'fetched',
        manifest_sha256: sha256,
        service: validation.manifest.service,
        version: validation.manifest.version,
        schema: validation.manifest.schema,
        diff: { items: diff.items, counts: diff.counts },
      });
    },
  );

  // ── Edit manifest_url (Phase 07 Fix #15 — allow admin to update after app create) ─────
  app.patch(
    '/v1/admin/apps/:id/manifest-url',
    { preHandler: [verifyJwt] },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: 'Invalid app id' });

      const bodySchema = z.object({
        manifest_url: z.string().url().startsWith('https://'),
      });
      const body = bodySchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: 'Invalid body', details: body.error.issues });

      const { rowCount } = await writerPool.query(
        `UPDATE rbac.apps SET manifest_url = $2, manifest_etag = NULL WHERE id = $1`,
        [params.data.id, body.data.manifest_url],
      );
      if (rowCount === 0) return reply.status(404).send({ error: 'App not found' });

      await writeAuditLog(request, {
        action: 'app.update.manifest_url',
        target_type: 'app',
        target_id: params.data.id,
        after_state: { manifest_url: body.data.manifest_url },
      });

      return reply.send({ status: 'updated', manifest_url: body.data.manifest_url });
    },
  );
}
