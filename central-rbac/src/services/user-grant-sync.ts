/**
 * user-grant-sync.ts — Outbox-backed user grant assignment/revocation.
 *
 * S1 gate findings (2026-08-25):
 *   - Zitadel enforces ONE grant per (user, project).
 *   - To add roles: if grant exists → update_user_grant (PUT, replaces role set).
 *   - If no grant yet → add_user_grant (POST).
 *   - To remove: remove_user_grant (DELETE) — 404 treated as success.
 *
 * H1+H4 fix (2026-08-25): enqueue-first pattern — no Zitadel call in hot path.
 *   - assignRoleToUser enqueues 'add_or_update_user_grant' with {userId, projectId, roleKey}.
 *   - The outbox worker (outbox-processor.ts) handles listUserGrants + decide + PUT/POST
 *     under a PostgreSQL advisory lock per (userId, projectId) to prevent lost-update race.
 *   - Returns {outbox_id, status:'pending'} immediately — no blocking Zitadel call.
 *
 * For removeRoleFromUser (partial revoke), Zitadel is still called in the hot path
 * because we need current role set to compute the diff. This is acceptable: DELETE
 * is rare (admin action), not concurrent with itself in practice, and the advisory
 * lock in the worker serializes any concurrent remove events for the same (user, project).
 */
import { createHash } from 'node:crypto';
import { writerPool } from '../db/writer-pool.js';
import { enqueueOutbox, type EnqueueResult } from '../db/queries/outbox.js';
import { listUserGrants } from '../lib/zitadel-mgmt-client.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIdempotencyKey(operation: string, ...parts: string[]): string {
  const payload = [operation, ...parts].join(':');
  return createHash('sha256').update(payload).digest('hex').slice(0, 64);
}

function getFallbackProjectId(): string {
  const id = config.ZITADEL_PROJECT_ID;
  if (!id) throw new Error('ZITADEL_PROJECT_ID not configured');
  return id;
}

function getOrgId(): string {
  return config.ZITADEL_ORG_ID || '';
}

/**
 * Migration 011: resolve Zitadel projectId from role.app_id → apps.zitadel_project_id.
 * Legacy roles (app_id NULL) fall back to env ZITADEL_PROJECT_ID.
 * Inline here (not imported from role-sync) to avoid potential circular dep.
 */
async function resolveProjectIdForRole(roleKey: string): Promise<string> {
  const { rows } = await writerPool.query<{ zitadel_project_id: string | null }>(
    `SELECT a.zitadel_project_id
       FROM rbac.roles r
       LEFT JOIN rbac.apps a ON a.id = r.app_id
      WHERE r.key = $1`,
    [roleKey],
  );
  return rows[0]?.zitadel_project_id ?? getFallbackProjectId();
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AssignRoleResult {
  outbox: EnqueueResult;
  /** Always 'add_or_update_user_grant' — worker decides add vs update at dispatch time */
  operation: 'add_or_update_user_grant';
}

/**
 * Assign a role to a user by enqueuing an outbox event.
 *
 * H4 fix: no Zitadel call in hot path — enqueues immediately and returns.
 * H1 fix: the worker serializes processing per (userId, projectId) via advisory lock,
 *         preventing the lost-update race where concurrent enqueues both read stale
 *         grant state and overwrite each other.
 *
 * Returns {status:'pending', outbox_id} — Zitadel sync happens asynchronously.
 */
export async function assignRoleToUser(
  userId: string,
  roleKey: string,
  correlationId?: string,
): Promise<AssignRoleResult> {
  // Migration 011 — resolve target Zitadel projectId from role.app_id link.
  // Legacy roles (app_id NULL) fall back to env ZITADEL_PROJECT_ID.
  // Wizard-created roles get routed to their app's own Zitadel project.
  const projectId = await resolveProjectIdForRole(roleKey);
  const orgId = getOrgId();

  // Idempotency key: bucketed by 10-second window so genuine network retries within
  // a click dedupe, but grant → revoke → grant across seconds each produces a fresh
  // event. Worker's advisory lock + merge logic makes multiple events safe anyway.
  // (Prior form omitted the time bucket → re-grant after revoke was swallowed by
  //  ON CONFLICT DO NOTHING referencing the original completed grant event.)
  const timeBucket = Math.floor(Date.now() / 10_000).toString();
  const idemKey = makeIdempotencyKey(
    'add_or_update_user_grant',
    userId,
    projectId,
    roleKey,
    timeBucket,
  );

  const outbox = await enqueueOutbox(
    writerPool,
    'add_or_update_user_grant',
    { userId, orgId, projectId, roleKey },
    idemKey,
    correlationId,
  );

  logger.info(
    { userId, roleKey, projectId, outboxId: outbox.id, inserted: outbox.inserted },
    'user-grant-sync: enqueued add_or_update_user_grant',
  );
  return { outbox, operation: 'add_or_update_user_grant' };
}

export interface RevokeRoleResult {
  outbox: EnqueueResult;
}

/**
 * Revoke a specific role from a user's grant by enqueuing an outbox event.
 *
 * Two modes:
 *   1. If targetRoleKey provided: partial revoke — fetches current roles from Zitadel,
 *      removes targetRoleKey, enqueues update_user_grant with remaining roles.
 *   2. If no targetRoleKey: full grant removal — enqueues remove_user_grant.
 *
 * Note: partial revoke still calls Zitadel synchronously (unavoidable — we need current
 * role set to compute diff). DELETE operations are rare admin actions; the advisory lock
 * in the worker serializes concurrent remove events per (userId, projectId).
 */
export async function removeRoleFromUser(
  userId: string,
  grantId: string,
  targetRoleKey?: string,
  correlationId?: string,
): Promise<RevokeRoleResult> {
  const orgId = getOrgId();

  if (targetRoleKey) {
    // Partial revoke: fetch current roles, remove targetRoleKey.
    // If the result is empty, do a full grant DELETE — Zitadel doesn't allow empty
    // grants and leaving one behind clutters the drawer with a zero-role row.
    let currentRoles: string[] = [];
    try {
      const grants = await listUserGrants(userId, orgId);
      const found = grants.find((g) => g.grantId === grantId);
      currentRoles = found?.roleKeys ?? [];
    } catch (err) {
      logger.warn({ err, userId, grantId }, 'user-grant-sync: listUserGrants failed for partial revoke');
    }

    const updatedRoles = currentRoles.filter((r) => r !== targetRoleKey);

    const timeBucket = Math.floor(Date.now() / 10_000).toString();

    if (updatedRoles.length === 0) {
      const idemKey = makeIdempotencyKey('remove_user_grant', userId, grantId, timeBucket);
      const outbox = await enqueueOutbox(
        writerPool,
        'remove_user_grant',
        { userId, orgId, grantId },
        idemKey,
        correlationId,
      );
      logger.info(
        { userId, grantId, targetRoleKey, outboxId: outbox.id },
        'user-grant-sync: last role revoked — enqueued remove_user_grant',
      );
      return { outbox };
    }

    const idemKey = makeIdempotencyKey(
      'update_user_grant_revoke',
      userId,
      grantId,
      targetRoleKey,
      timeBucket,
    );

    const outbox = await enqueueOutbox(
      writerPool,
      'update_user_grant',
      { userId, orgId, grantId, roleKeys: updatedRoles },
      idemKey,
      correlationId,
    );

    logger.info({ userId, grantId, targetRoleKey, outboxId: outbox.id }, 'user-grant-sync: enqueued update_user_grant (partial revoke)');
    return { outbox };
  }

  // Full grant removal
  const timeBucket = Math.floor(Date.now() / 10_000).toString();
  const idemKey = makeIdempotencyKey('remove_user_grant', userId, grantId, timeBucket);
  const outbox = await enqueueOutbox(
    writerPool,
    'remove_user_grant',
    { userId, orgId, grantId },
    idemKey,
    correlationId,
  );

  logger.info({ userId, grantId, outboxId: outbox.id }, 'user-grant-sync: enqueued remove_user_grant');
  return { outbox };
}

/**
 * List current user grants from Zitadel (live, cached by caller if needed).
 * Re-exports for use in route handlers.
 */
export async function getUserGrants(
  userId: string,
): Promise<Array<{ grantId: string; projectId: string; roleKeys: string[] }>> {
  const orgId = getOrgId();
  const grants = await listUserGrants(userId, orgId);
  return grants.map((g) => ({
    grantId: g.grantId,
    projectId: g.projectId,
    roleKeys: g.roleKeys,
  }));
}
