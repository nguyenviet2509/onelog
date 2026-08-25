/**
 * outbox-processor.ts — Per-operation Zitadel Mgmt API handlers for outbox worker.
 * Validates args shape before calling client functions.
 * Throws on non-idempotent errors; worker handles retry/dead-letter logic.
 *
 * Idempotency handled here:
 *   - 409 responses → treated as success in mgmt-client (no throw)
 *   - 404 on removeUserGrant → treated as success in mgmt-client (no throw)
 */
import {
  addProjectRole as clientAddProjectRole,
  removeProjectRole as clientRemoveProjectRole,
  addUserGrant as clientAddUserGrant,
  updateUserGrant as clientUpdateUserGrant,
  removeUserGrant as clientRemoveUserGrant,
} from '../lib/zitadel-mgmt-client.js';
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
