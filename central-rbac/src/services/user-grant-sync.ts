/**
 * user-grant-sync.ts — Outbox-backed user grant assignment/revocation.
 *
 * S1 gate findings (2026-08-25):
 *   - Zitadel enforces ONE grant per (user, project).
 *   - To add roles: if grant exists → update_user_grant (PUT, replaces role set).
 *   - If no grant yet → add_user_grant (POST).
 *   - To remove: remove_user_grant (DELETE) — 404 treated as success.
 *
 * Central DB does NOT store grantId (Zitadel-internal). The outbox args carry
 * grantId when known (update/remove); for initial add, grantId comes from
 * Zitadel response stored back by the worker (out of scope for Phase 3 —
 * worker logs grantId, admin can retrieve via GET /v1/assignments).
 *
 * All mutations are enqueued to outbox (non-blocking); Zitadel sync is async.
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

function getProjectId(): string {
  const id = config.ZITADEL_PROJECT_ID;
  if (!id) throw new Error('ZITADEL_PROJECT_ID not configured');
  return id;
}

function getOrgId(): string {
  return config.ZITADEL_ORG_ID || '';
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AssignRoleResult {
  outbox: EnqueueResult;
  /** 'add' = new grant enqueued; 'update' = existing grant update enqueued */
  operation: 'add_user_grant' | 'update_user_grant';
}

/**
 * Assign a role to a user by enqueuing an outbox event.
 *
 * Checks Zitadel for an existing grant on this (user, project):
 *   - If found → enqueue update_user_grant with merged role set
 *   - If not found → enqueue add_user_grant
 *
 * The live Zitadel check adds ~1 API call but prevents orphaned grants.
 * On Zitadel unreachable: falls back to add_user_grant (409 handled by worker).
 */
export async function assignRoleToUser(
  userId: string,
  roleKey: string,
  correlationId?: string,
): Promise<AssignRoleResult> {
  const projectId = getProjectId();
  const orgId = getOrgId();

  // Check for existing grant to determine add vs update
  let existingGrant: { grantId: string; roleKeys: string[] } | null = null;
  try {
    const grants = await listUserGrants(userId, orgId);
    const found = grants.find((g) => g.projectId === projectId);
    if (found) {
      existingGrant = { grantId: found.grantId, roleKeys: found.roleKeys };
    }
  } catch (err) {
    logger.warn({ err, userId }, 'user-grant-sync: listUserGrants failed — falling back to add');
  }

  if (existingGrant) {
    // Merge: add roleKey if not already present
    const mergedRoles = Array.from(new Set([...existingGrant.roleKeys, roleKey]));
    const idemKey = makeIdempotencyKey(
      'update_user_grant',
      userId,
      projectId,
      existingGrant.grantId,
      mergedRoles.sort().join(','),
    );

    const outbox = await enqueueOutbox(
      writerPool,
      'update_user_grant',
      {
        userId,
        orgId,
        grantId: existingGrant.grantId,
        roleKeys: mergedRoles,
      },
      idemKey,
      correlationId,
    );

    logger.info(
      { userId, roleKey, grantId: existingGrant.grantId, outboxId: outbox.id },
      'user-grant-sync: enqueued update_user_grant',
    );
    return { outbox, operation: 'update_user_grant' };
  }

  // No existing grant — enqueue add
  const idemKey = makeIdempotencyKey('add_user_grant', userId, projectId, roleKey);
  const outbox = await enqueueOutbox(
    writerPool,
    'add_user_grant',
    { userId, orgId, projectId, roleKeys: [roleKey] },
    idemKey,
    correlationId,
  );

  logger.info({ userId, roleKey, outboxId: outbox.id }, 'user-grant-sync: enqueued add_user_grant');
  return { outbox, operation: 'add_user_grant' };
}

export interface RevokeRoleResult {
  outbox: EnqueueResult;
}

/**
 * Revoke a specific role from a user's grant by enqueuing an outbox event.
 *
 * Two modes:
 *   1. If grantId provided + targetRoleKey provided: remove only that role
 *      (enqueue update_user_grant with role removed from set).
 *   2. If grantId provided + no targetRoleKey: remove entire grant
 *      (enqueue remove_user_grant).
 *
 * 404 on remove_user_grant → worker treats as success.
 */
export async function removeRoleFromUser(
  userId: string,
  grantId: string,
  targetRoleKey?: string,
  correlationId?: string,
): Promise<RevokeRoleResult> {
  const orgId = getOrgId();

  if (targetRoleKey) {
    // Partial revoke: fetch current roles, remove targetRoleKey, enqueue update
    let currentRoles: string[] = [];
    try {
      const grants = await listUserGrants(userId, orgId);
      const found = grants.find((g) => g.grantId === grantId);
      currentRoles = found?.roleKeys ?? [];
    } catch (err) {
      logger.warn({ err, userId, grantId }, 'user-grant-sync: listUserGrants failed for partial revoke');
    }

    const updatedRoles = currentRoles.filter((r) => r !== targetRoleKey);
    const idemKey = makeIdempotencyKey(
      'update_user_grant_revoke',
      userId,
      grantId,
      targetRoleKey,
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
  const idemKey = makeIdempotencyKey('remove_user_grant', userId, grantId);
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
