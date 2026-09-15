/**
 * outbox-processor.ts — Per-operation Zitadel Mgmt API handlers for outbox worker.
 * Validates args shape before calling client functions.
 * Throws on non-idempotent errors; worker handles retry/dead-letter logic.
 *
 * Idempotency handled here:
 *   - 409 responses → treated as success in mgmt-client (no throw)
 *   - 404 on removeUserGrant → treated as success in mgmt-client (no throw)
 *
 * H1+H4 fix (2026-08-25): add_or_update_user_grant operation.
 *   - Worker-side: listUserGrants → decide add vs update → call Zitadel.
 *   - Serialized via PostgreSQL advisory lock per (userId, projectId):
 *     pg_advisory_xact_lock(hashtext('ugrant:' || userId || ':' || projectId))
 *   - This prevents the lost-update race: two concurrent add_or_update events for
 *     same (userId, projectId) are serialized in the DB — the second reads the
 *     state left by the first (correct merged set), not the stale pre-first state.
 */
import { createHmac } from 'node:crypto';
import {
  addProjectRole as clientAddProjectRole,
  updateProjectRole as clientUpdateProjectRole,
  removeProjectRole as clientRemoveProjectRole,
} from '../lib/zitadel-project-roles-client.js';
import {
  addUserGrant as clientAddUserGrant,
  updateUserGrant as clientUpdateUserGrant,
  removeUserGrant as clientRemoveUserGrant,
  listUserGrants,
} from '../lib/zitadel-user-grants-client.js';
import { getUserById } from '../lib/zitadel-user-search-client.js';
import { ZitadelHttpError } from '../lib/zitadel-http-error.js';
import { writerPool } from '../db/writer-pool.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { expandRoleHierarchyV1Safe } from '../lib/expand-role-hierarchy.js';

function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`outbox-processor: missing required arg '${key}'`);
  }
  return val;
}

function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const val = args[key];
  if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
    throw new Error(`outbox-processor: '${key}' must be a string array`);
  }
  return val as string[];
}

function optionalString(args: Record<string, unknown>, key: string): string | null {
  const val = args[key];
  return typeof val === 'string' && val.length > 0 ? val : null;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] {
  const val = args[key];
  if (!Array.isArray(val)) return [];
  return val.filter((v): v is string => typeof v === 'string');
}

/**
 * Fix cho grant sync gap (plan 260915-1615 phase 1):
 * Central UI POST /v1/assignments enqueue outbox → worker sync Zitadel only.
 * SDK POST /v2/resolve đọc rbac.user_grants exclusively → grant qua UI không reach SDK.
 *
 * Sau khi Zitadel call thành công, mirror grant vào rbac.user_grants.
 *
 * Idempotent: schema `UNIQUE (user_sub, app_id, role_key, tenant_id)` — nhưng Postgres
 * treat NULLs distinct → dùng `WHERE NOT EXISTS` filter tenant_id IS NULL để tránh dup.
 *
 * Skip conditions (log warn, không fail):
 *   - projectId không có app tương ứng trong rbac.apps (legacy Zitadel-only apps)
 *   - roleKey không tồn tại trong rbac.roles (legacy Zitadel-only roles)
 *
 * Rationale: Zitadel đã sync, không cần retry vô hạn cho legacy state. Backfill script
 * xử lý migration legacy grants riêng.
 */
async function mirrorGrantInsert(
  client: import('pg').PoolClient | import('pg').Pool,
  params: { userId: string; projectId: string; roleKey: string; grantorSub: string | null },
): Promise<void> {
  const { userId, projectId, roleKey, grantorSub } = params;
  const grantor = grantorSub ?? 'system';

  const appRes = await client.query<{ id: string }>(
    `SELECT id FROM rbac.apps WHERE zitadel_project_id = $1 LIMIT 1`,
    [projectId],
  );
  const appId = appRes.rows[0]?.id;
  if (!appId) {
    logger.warn(
      { projectId, userId, roleKey },
      'outbox-processor: mirrorGrantInsert skipped — no app row for projectId (legacy)',
    );
    return;
  }

  const roleRes = await client.query<{ key: string }>(
    `SELECT key FROM rbac.roles WHERE key = $1 LIMIT 1`,
    [roleKey],
  );
  if (roleRes.rows.length === 0) {
    logger.warn(
      { roleKey, userId, appId },
      'outbox-processor: mirrorGrantInsert skipped — role not in rbac.roles (legacy)',
    );
    return;
  }

  const insertRes = await client.query(
    `INSERT INTO rbac.user_grants (user_sub, app_id, role_key, tenant_id, granted_by_sub)
     SELECT $1, $2, $3, NULL, $4
     WHERE NOT EXISTS (
       SELECT 1 FROM rbac.user_grants
        WHERE user_sub = $1 AND app_id = $2 AND role_key = $3 AND tenant_id IS NULL
     )`,
    [userId, appId, roleKey, grantor],
  );
  logger.info(
    { userId, appId, roleKey, grantor, inserted: insertRes.rowCount ?? 0 },
    'outbox-processor: mirrorGrantInsert done',
  );
}

async function mirrorGrantDelete(
  client: import('pg').PoolClient | import('pg').Pool,
  params: { userId: string; projectId: string | null; roleKeys: string[] },
): Promise<void> {
  const { userId, projectId, roleKeys } = params;
  if (!projectId || roleKeys.length === 0) {
    logger.info(
      { userId, projectId, roleKeys },
      'outbox-processor: mirrorGrantDelete skipped — missing projectId or empty roleKeys',
    );
    return;
  }

  const appRes = await client.query<{ id: string }>(
    `SELECT id FROM rbac.apps WHERE zitadel_project_id = $1 LIMIT 1`,
    [projectId],
  );
  const appId = appRes.rows[0]?.id;
  if (!appId) {
    logger.warn(
      { projectId, userId, roleKeys },
      'outbox-processor: mirrorGrantDelete skipped — no app row for projectId (legacy)',
    );
    return;
  }

  const delRes = await client.query(
    `DELETE FROM rbac.user_grants
      WHERE user_sub = $1
        AND app_id = $2
        AND role_key = ANY($3::text[])
        AND tenant_id IS NULL`,
    [userId, appId, roleKeys],
  );
  logger.info(
    { userId, appId, roleKeys, deleted: delRes.rowCount ?? 0 },
    'outbox-processor: mirrorGrantDelete done',
  );
}

function getOrgId(args: Record<string, unknown>): string {
  // orgId can be overridden per-event; falls back to global default
  const val = args['orgId'];
  if (typeof val === 'string' && val.length > 0) return val;
  const defaultOrgId = config.ZITADEL_ORG_ID;
  if (!defaultOrgId) throw new Error('outbox-processor: orgId missing and ZITADEL_ORG_ID not set');
  return defaultOrgId;
}

/**
 * add_project_role — args: { projectId, orgId?, roleKey, displayName, group? }
 * 409 from Zitadel is treated as success in client layer.
 */
export async function addProjectRole(args: Record<string, unknown>): Promise<void> {
  const projectId = requireString(args, 'projectId');
  const orgId = getOrgId(args);
  const roleKey = requireString(args, 'roleKey');
  const displayName = requireString(args, 'displayName');
  const group = typeof args['group'] === 'string' ? args['group'] : '';

  logger.info({ projectId, roleKey }, 'outbox-processor: add_project_role');
  await clientAddProjectRole(projectId, orgId, roleKey, displayName, group);
}

/**
 * update_project_role — args: { projectId, orgId?, roleKey, displayName, group? }
 * PUT is naturally idempotent; 404 (role gone) treated as success in client.
 */
export async function updateProjectRole(args: Record<string, unknown>): Promise<void> {
  const projectId = requireString(args, 'projectId');
  const orgId = getOrgId(args);
  const roleKey = requireString(args, 'roleKey');
  const displayName = requireString(args, 'displayName');
  const group = typeof args['group'] === 'string' ? args['group'] : '';

  logger.info({ projectId, roleKey, displayName }, 'outbox-processor: update_project_role');
  await clientUpdateProjectRole(projectId, orgId, roleKey, displayName, group);
}

/**
 * remove_project_role — args: { projectId, orgId?, roleKey }
 * Zitadel returns 200 idempotently on second call.
 */
export async function removeProjectRole(args: Record<string, unknown>): Promise<void> {
  const projectId = requireString(args, 'projectId');
  const orgId = getOrgId(args);
  const roleKey = requireString(args, 'roleKey');

  logger.info({ projectId, roleKey }, 'outbox-processor: remove_project_role');
  await clientRemoveProjectRole(projectId, orgId, roleKey);
}

/**
 * add_user_grant — args: { userId, orgId?, projectId, roleKeys[] }
 * 409 from Zitadel is treated as success (grant exists = goal achieved).
 * Returns grantId from Zitadel response (empty string if 409).
 */
export async function addUserGrant(args: Record<string, unknown>): Promise<string> {
  const userId = requireString(args, 'userId');
  const orgId = getOrgId(args);
  const projectId = requireString(args, 'projectId');
  const roleKeys = requireStringArray(args, 'roleKeys');

  logger.info({ userId, projectId, roleKeys }, 'outbox-processor: add_user_grant');
  const result = await clientAddUserGrant(userId, orgId, projectId, roleKeys);
  return result.grantId;
}

/**
 * update_user_grant — args: { userId, orgId?, grantId, roleKeys[], projectId?, previousRoleKeys?[], grantorSub? }
 * REPLACES full role set — caller must provide complete desired list.
 *
 * Mirror plan 260915-1615 phase 1: sau khi Zitadel PUT thành công, sync rbac.user_grants:
 *   - DELETE removed = previousRoleKeys - roleKeys
 *   - INSERT added = roleKeys - previousRoleKeys
 * projectId + previousRoleKeys optional cho backward compat với events cũ trong queue.
 */
export async function updateUserGrant(args: Record<string, unknown>): Promise<void> {
  const userId = requireString(args, 'userId');
  const orgId = getOrgId(args);
  const grantId = requireString(args, 'grantId');
  const roleKeys = requireStringArray(args, 'roleKeys');
  const projectId = optionalString(args, 'projectId');
  const previousRoleKeys = optionalStringArray(args, 'previousRoleKeys');
  const grantorSub = optionalString(args, 'grantorSub');

  logger.info({ userId, grantId, roleCount: roleKeys.length }, 'outbox-processor: update_user_grant');
  await clientUpdateUserGrant(userId, orgId, grantId, roleKeys);

  // Mirror rbac.user_grants sync — surgical diff
  if (!projectId) {
    logger.warn(
      { userId, grantId },
      'outbox-processor: update_user_grant DB mirror skipped — projectId missing (legacy queued event)',
    );
    return;
  }
  const currentSet = new Set(previousRoleKeys);
  const targetSet = new Set(roleKeys);
  const removed = previousRoleKeys.filter((k) => !targetSet.has(k));
  const added = roleKeys.filter((k) => !currentSet.has(k));
  if (removed.length > 0) {
    await mirrorGrantDelete(writerPool, { userId, projectId, roleKeys: removed });
  }
  for (const roleKey of added) {
    await mirrorGrantInsert(writerPool, { userId, projectId, roleKey, grantorSub });
  }
}

/**
 * remove_user_grant — args: { userId, orgId?, grantId, projectId?, previousRoleKeys?[], grantorSub? }
 * 404 from Zitadel is treated as success in client layer.
 *
 * Mirror plan 260915-1615 phase 1: sau khi Zitadel DELETE thành công, DELETE rbac.user_grants
 * matching (userSub, appId, previousRoleKeys, tenant_id IS NULL).
 * projectId + previousRoleKeys optional cho backward compat.
 */
export async function removeUserGrant(args: Record<string, unknown>): Promise<void> {
  const userId = requireString(args, 'userId');
  const orgId = getOrgId(args);
  const grantId = requireString(args, 'grantId');
  const projectId = optionalString(args, 'projectId');
  const previousRoleKeys = optionalStringArray(args, 'previousRoleKeys');

  logger.info({ userId, grantId }, 'outbox-processor: remove_user_grant');
  await clientRemoveUserGrant(userId, orgId, grantId);

  if (!projectId || previousRoleKeys.length === 0) {
    logger.warn(
      { userId, grantId, projectId, previousRoleKeys },
      'outbox-processor: remove_user_grant DB mirror skipped — missing projectId or previousRoleKeys',
    );
    return;
  }
  await mirrorGrantDelete(writerPool, { userId, projectId, roleKeys: previousRoleKeys });
}

/**
 * add_or_update_user_grant — args: { userId, orgId?, projectId, roleKey }
 *
 * H1+H4 fix: Zitadel read-modify-write is done HERE in the worker, not in the
 * HTTP request handler. This keeps the POST /v1/assignments hot path non-blocking.
 *
 * Serialization via PostgreSQL advisory lock:
 *   pg_advisory_xact_lock(hashtext('ugrant:' || userId || ':' || projectId))
 *
 * The lock is held for the duration of the DB transaction that wraps
 * listUserGrants + decide + Zitadel call. Concurrent events for the same
 * (userId, projectId) wait at the lock, then read the correct updated state
 * from Zitadel, preventing the lost-update race.
 *
 * Advisory lock is xact-scoped: auto-released on COMMIT/ROLLBACK.
 */
export async function addOrUpdateUserGrant(args: Record<string, unknown>): Promise<void> {
  const userId = requireString(args, 'userId');
  const orgId = getOrgId(args);
  const projectId = requireString(args, 'projectId');
  const roleKey = requireString(args, 'roleKey');
  const grantorSub = optionalString(args, 'grantorSub');

  logger.info({ userId, projectId, roleKey }, 'outbox-processor: add_or_update_user_grant');

  // Acquire advisory lock per (userId, projectId) for duration of this operation.
  // hashtext() returns int4 — pg_advisory_xact_lock takes bigint, implicit cast is safe.
  // Lock key formula: 'ugrant:{userId}:{projectId}' → deterministic, collision-resistant.
  const client = await writerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`ugrant:${userId}:${projectId}`],
    );

    // Read current state from Zitadel (inside the lock — serial for this (user, project))
    let existingGrant: { grantId: string; roleKeys: string[] } | null = null;
    try {
      const grants = await listUserGrants(userId, orgId);
      const found = grants.find((g) => g.projectId === projectId);
      if (found) {
        existingGrant = { grantId: found.grantId, roleKeys: found.roleKeys };
      }
    } catch (err) {
      // Zitadel unreachable — rollback and let worker retry
      await client.query('ROLLBACK');
      throw err;
    }

    if (existingGrant) {
      // Merge: add roleKey only if not already present (idempotent)
      if (!existingGrant.roleKeys.includes(roleKey)) {
        // Phase 09 (plan 260910-1334): expand hierarchy TRƯỚC PUT.
        // V1 backward-compat guard: expandRoleHierarchyV1Safe returns input sorted (no expand)
        //   nếu MỌI role trong list có parent_key=NULL → existing v1 grants (qlts, onemcp)
        //   KHÔNG bị re-synced expanded → Zitadel Console state unchanged.
        // V2 roles (parent_key set) → expand full chain → Zitadel JWT có inherited roles.
        const mergedRoles = [...existingGrant.roleKeys, roleKey];
        const expandedRoles = await expandRoleHierarchyV1Safe(client, mergedRoles);
        logger.info(
          { userId, projectId, grantId: existingGrant.grantId, mergedRoles, expandedRoles },
          'outbox-processor: updating existing grant with (hierarchy-expanded) merged roles',
        );
        await clientUpdateUserGrant(userId, orgId, existingGrant.grantId, expandedRoles);
      } else {
        // Role already present — idempotent success, no Zitadel call needed
        logger.info(
          { userId, projectId, roleKey },
          'outbox-processor: role already in grant — no-op',
        );
      }
    } else {
      // No grant for this project yet — create new với hierarchy expand (V1-safe)
      const expandedRoles = await expandRoleHierarchyV1Safe(client, [roleKey]);
      logger.info(
        { userId, projectId, roleKey, expandedRoles },
        'outbox-processor: creating new grant with hierarchy-expanded roles',
      );
      await clientAddUserGrant(userId, orgId, projectId, expandedRoles);
    }

    // Mirror DIRECT grant to rbac.user_grants inside advisory lock txn (plan 260915-1615 phase 1).
    // Chỉ mirror roleKey được cấp trực tiếp (không mirror expandedRoles hierarchy parents —
    // resolve-v2 recursive CTE tự expand khi query). Idempotent qua WHERE NOT EXISTS.
    await mirrorGrantInsert(client, { userId, projectId, roleKey, grantorSub });

    // COMMIT releases the advisory lock
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * notify_app_revoke — args: { appId, userId }
 *
 * P2 "immediate revoke" (2026-09-09). Sau admin revoke user grant, Central push event tới
 * app-side revoke webhook để app xóa local session state (JWT/refresh_tokens/group members).
 * Không cần chờ TTL access token expire.
 *
 * Flow:
 *   1. Lookup app.revoke_url + app.revoke_secret + app.zitadel_org_id từ rbac.apps
 *   2. Nếu revoke_url NULL → no-op (app không support, đây là fallback graceful)
 *   3. Get user email từ Zitadel Mgmt API `/v2/users/:id`
 *   4. Build HMAC-SHA256 signature: msg = `${email.toLowerCase()}|revoke`
 *   5. POST revoke_url với `X-Sso-Revoke-Signature: sha256=${hex}` header + JSON body {userEmail}
 *   6. 2xx = done, 4xx = permanent fail (dead), 5xx/network = retry
 *
 * Timeout 10s (app should respond nhanh — chỉ xóa DB row).
 */
export async function notifyAppRevoke(args: Record<string, unknown>): Promise<void> {
  const appId = requireString(args, 'appId');
  const userId = requireString(args, 'userId');

  const { rows } = await writerPool.query<{
    revoke_url: string | null;
    revoke_secret: string | null;
    zitadel_org_id: string | null;
    slug: string;
  }>(
    `SELECT revoke_url, revoke_secret, zitadel_org_id, slug FROM rbac.apps WHERE id = $1`,
    [appId],
  );
  const app = rows[0];
  if (!app) {
    // App bị xóa giữa lúc enqueue và process — skip, không phải error
    logger.warn({ appId }, 'notify_app_revoke: app not found — skipping');
    return;
  }
  if (!app.revoke_url || !app.revoke_secret) {
    logger.info(
      { appId, slug: app.slug },
      'notify_app_revoke: app has no revoke_url/secret — skipping (backward-compat)',
    );
    return;
  }

  const orgId = app.zitadel_org_id ?? config.ZITADEL_ORG_ID;
  const user = await getUserById(userId, orgId);
  if (!user?.email) {
    // User không có email trong Zitadel → không sign được HMAC → mark dead
    throw new Error(`notify_app_revoke: user ${userId} has no email in Zitadel`);
  }

  const email = user.email.toLowerCase();
  const msg = `${email}|revoke`;
  const sig = createHmac('sha256', app.revoke_secret).update(msg).digest('hex');

  logger.info(
    { appId, slug: app.slug, userEmail: email, revoke_url: app.revoke_url },
    'notify_app_revoke: calling app webhook',
  );

  let res: Response;
  try {
    res = await fetch(app.revoke_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sso-Revoke-Signature': `sha256=${sig}`,
      },
      body: JSON.stringify({ userEmail: email }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Network error / timeout → treated as 5xx (retry)
    throw new Error(`notify_app_revoke fetch error: ${errMsg}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error(
      { appId, status: res.status, body: body.slice(0, 200) },
      'notify_app_revoke: app webhook non-2xx',
    );
    // ZitadelHttpError vì dispatcher đã match instanceof/HTTP regex to classify 4xx vs 5xx
    throw new ZitadelHttpError(res.status, `App revoke webhook HTTP ${res.status}`);
  }

  logger.info({ appId, userEmail: email }, 'notify_app_revoke: ok');
}
