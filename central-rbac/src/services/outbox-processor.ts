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
import {
  addProjectRole as clientAddProjectRole,
  removeProjectRole as clientRemoveProjectRole,
} from '../lib/zitadel-project-roles-client.js';
import {
  addUserGrant as clientAddUserGrant,
  updateUserGrant as clientUpdateUserGrant,
  removeUserGrant as clientRemoveUserGrant,
  listUserGrants,
} from '../lib/zitadel-user-grants-client.js';
import { writerPool } from '../db/writer-pool.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

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
 * update_user_grant — args: { userId, orgId?, grantId, roleKeys[] }
 * REPLACES full role set — caller must provide complete desired list.
 */
export async function updateUserGrant(args: Record<string, unknown>): Promise<void> {
  const userId = requireString(args, 'userId');
  const orgId = getOrgId(args);
  const grantId = requireString(args, 'grantId');
  const roleKeys = requireStringArray(args, 'roleKeys');

  logger.info({ userId, grantId, roleCount: roleKeys.length }, 'outbox-processor: update_user_grant');
  await clientUpdateUserGrant(userId, orgId, grantId, roleKeys);
}

/**
 * remove_user_grant — args: { userId, orgId?, grantId }
 * 404 from Zitadel is treated as success in client layer.
 */
export async function removeUserGrant(args: Record<string, unknown>): Promise<void> {
  const userId = requireString(args, 'userId');
  const orgId = getOrgId(args);
  const grantId = requireString(args, 'grantId');

  logger.info({ userId, grantId }, 'outbox-processor: remove_user_grant');
  await clientRemoveUserGrant(userId, orgId, grantId);
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
        const mergedRoles = [...existingGrant.roleKeys, roleKey];
        logger.info(
          { userId, projectId, grantId: existingGrant.grantId, mergedRoles },
          'outbox-processor: updating existing grant with merged roles',
        );
        await clientUpdateUserGrant(userId, orgId, existingGrant.grantId, mergedRoles);
      } else {
        // Role already present — idempotent success, no Zitadel call needed
        logger.info(
          { userId, projectId, roleKey },
          'outbox-processor: role already in grant — no-op',
        );
      }
    } else {
      // No grant for this project yet — create new
      logger.info({ userId, projectId, roleKey }, 'outbox-processor: creating new grant');
      await clientAddUserGrant(userId, orgId, projectId, [roleKey]);
    }

    // COMMIT releases the advisory lock
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
