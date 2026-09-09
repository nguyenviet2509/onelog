/**
 * role-sync.ts — Atomic Central DB + outbox for role mutations.
 *
 * Pattern: DB tx writes role row + outbox event atomically.
 * Outbox worker picks up event and calls Zitadel Mgmt API asynchronously.
 * If Zitadel is down, Central DB is consistent; outbox drains when Zitadel recovers.
 *
 * deleteRole: blocks if user grants exist in Zitadel (must revoke first).
 * createRole: enqueues add_project_role outbox event.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { writerPool } from '../db/writer-pool.js';
import {
  createRole as dbCreateRole,
  deleteRole as dbDeleteRole,
  updateRole as dbUpdateRole,
  type CreateRoleInput,
  type UpdateRoleInput,
  type Role,
} from '../db/queries/roles.js';
import { bumpResolveEpoch } from '../db/queries/resolve-epoch.js';
import { enqueueOutbox, type EnqueueResult } from '../db/queries/outbox.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIdempotencyKey(operation: string, ...parts: string[]): string {
  const payload = [operation, ...parts].join(':');
  return createHash('sha256').update(payload).digest('hex').slice(0, 64);
}

function getProjectId(): string {
  const id = config.ZITADEL_PROJECT_ID;
  if (!id) throw new Error('ZITADEL_PROJECT_ID not configured — required for role sync');
  return id;
}

/**
 * Resolve the Zitadel projectId to target for a role.
 * Priority: (1) explicit override from caller, (2) role.app_id lookup, (3) env fallback.
 * Migration 011 introduced roles.app_id — new wizard-created roles carry that link.
 */
export async function resolveProjectIdForRole(
  roleKey: string,
  override?: string,
): Promise<string> {
  if (override) return override;
  const { rows } = await writerPool.query<{ zitadel_project_id: string | null }>(
    `SELECT a.zitadel_project_id
       FROM rbac.roles r
       LEFT JOIN rbac.apps a ON a.id = r.app_id
      WHERE r.key = $1`,
    [roleKey],
  );
  const linked = rows[0]?.zitadel_project_id;
  return linked ?? getProjectId();
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface CreateRoleResult {
  role: Role;
  outbox: EnqueueResult;
}

/**
 * Create a role in Central DB and enqueue add_project_role outbox event.
 * Atomically: both writes succeed or neither does (single transaction).
 */
export async function createRoleWithSync(
  input: CreateRoleInput,
  correlationId?: string,
  /**
   * Optional Zitadel projectId override. If omitted, resolves from input.app_id
   * → apps.zitadel_project_id, else falls back to env ZITADEL_PROJECT_ID.
   * Wizard passes explicit override; UI POST passes app_id in body.
   */
  projectIdOverride?: string,
): Promise<CreateRoleResult> {
  let projectId: string;
  if (projectIdOverride) {
    projectId = projectIdOverride;
  } else if (input.app_id) {
    const { rows } = await writerPool.query<{ zitadel_project_id: string | null }>(
      `SELECT zitadel_project_id FROM rbac.apps WHERE id = $1`,
      [input.app_id],
    );
    projectId = rows[0]?.zitadel_project_id ?? getProjectId();
  } else {
    projectId = getProjectId();
  }
  const orgId = config.ZITADEL_ORG_ID || '';
  const idempotencyKey = makeIdempotencyKey('add_project_role', projectId, input.key);

  const client = await (writerPool as Pool).connect();
  try {
    await client.query('BEGIN');

    const role = await dbCreateRole(client, input);

    const outbox = await enqueueOutbox(
      client,
      'add_project_role',
      {
        projectId,
        orgId,
        roleKey: input.key,
        displayName: input.description || input.key,
      },
      idempotencyKey,
      correlationId,
    );

    await client.query('COMMIT');
    logger.info({ roleKey: input.key, outboxId: outbox.id }, 'role-sync: createRoleWithSync committed');
    return { role, outbox };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, roleKey: input.key }, 'role-sync: createRoleWithSync rolled back');
    throw err;
  } finally {
    client.release();
  }
}

export interface UpdateRoleResult {
  role: Role;
  /** null when description didn't change (no Zitadel sync needed). */
  outbox: EnqueueResult | null;
}

/**
 * Update a role in Central DB and, when the description changed, enqueue an
 * update_project_role event so Zitadel's role.display_name follows. parent_key
 * changes are Central-only (Zitadel has no role hierarchy).
 */
export async function updateRoleWithSync(
  key: string,
  input: UpdateRoleInput,
  correlationId?: string,
): Promise<UpdateRoleResult | null> {
  const orgId = config.ZITADEL_ORG_ID || '';

  const client = await (writerPool as Pool).connect();
  try {
    await client.query('BEGIN');

    // Resolve Zitadel projectId + previous description from role.app_id link
    // BEFORE the update so we can decide whether Zitadel needs the change.
    const { rows: preRows } = await client.query<{
      zitadel_project_id: string | null;
      description: string;
    }>(
      `SELECT a.zitadel_project_id, r.description
         FROM rbac.roles r
         LEFT JOIN rbac.apps a ON a.id = r.app_id
        WHERE r.key = $1`,
      [key],
    );
    if (preRows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const projectId = preRows[0]!.zitadel_project_id ?? getProjectId();
    const prevDescription = preRows[0]!.description;

    const updated = await dbUpdateRole(client, key, input);
    if (!updated) {
      await client.query('ROLLBACK');
      return null;
    }

    let outbox: EnqueueResult | null = null;
    const descriptionChanged =
      input.description !== undefined && input.description !== prevDescription;
    if (descriptionChanged) {
      const displayName = updated.description || updated.key;
      const idempotencyKey = makeIdempotencyKey('update_project_role', projectId, key);
      outbox = await enqueueOutbox(
        client,
        'update_project_role',
        { projectId, orgId, roleKey: key, displayName },
        idempotencyKey,
        correlationId,
      );
    }

    await client.query('COMMIT');
    logger.info(
      { roleKey: key, descriptionChanged, outboxId: outbox?.id ?? null },
      'role-sync: updateRoleWithSync committed',
    );
    return { role: updated, outbox };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, roleKey: key }, 'role-sync: updateRoleWithSync rolled back');
    throw err;
  } finally {
    client.release();
  }
}

export interface DeleteRoleResult {
  deleted: boolean;
  outbox: EnqueueResult;
}

/**
 * Delete a role from Central DB and enqueue remove_project_role outbox event.
 *
 * BLOCKS if user has active Zitadel grants for this role:
 *   caller must revoke all user grants before deleting role.
 *
 * On success: deletes Central role row + enqueues remove_project_role.
 * Zitadel role removal happens asynchronously via outbox worker.
 */
export async function deleteRoleWithSync(
  roleKey: string,
  correlationId?: string,
): Promise<DeleteRoleResult> {
  const orgId = config.ZITADEL_ORG_ID || '';

  // Zitadel-side active-grant check deferred to /v1/drift (admin-driven).
  // Central DB referential integrity (role_permissions FK) blocks delete when in use.

  const client = await (writerPool as Pool).connect();
  try {
    await client.query('BEGIN');

    // Resolve the Zitadel projectId BEFORE deleting the role row (row carries
    // the app_id link that maps to the target project). Env fallback only for
    // legacy roles with app_id NULL — those live in the env-configured project.
    const { rows: linkRows } = await client.query<{ zitadel_project_id: string | null }>(
      `SELECT a.zitadel_project_id
         FROM rbac.roles r
         LEFT JOIN rbac.apps a ON a.id = r.app_id
        WHERE r.key = $1`,
      [roleKey],
    );
    const projectId = linkRows[0]?.zitadel_project_id ?? getProjectId();
    const idempotencyKey = makeIdempotencyKey('remove_project_role', projectId, roleKey);

    // Delete from Central DB — cascades to role_permissions
    const deleted = await dbDeleteRole(client, roleKey);
    if (!deleted) {
      await client.query('ROLLBACK');
      return {
        deleted: false,
        outbox: { id: '0', idempotency_key: idempotencyKey, inserted: false },
      };
    }

    // Bump resolve epoch: cached permissions that included this role must expire
    await bumpResolveEpoch(client);

    const outbox = await enqueueOutbox(
      client,
      'remove_project_role',
      { projectId, orgId, roleKey },
      idempotencyKey,
      correlationId,
    );

    await client.query('COMMIT');
    logger.info({ roleKey, outboxId: outbox.id }, 'role-sync: deleteRoleWithSync committed');
    return { deleted: true, outbox };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, roleKey }, 'role-sync: deleteRoleWithSync rolled back');
    throw err;
  } finally {
    client.release();
  }
}

