/**
 * services/delegation-check.ts — Atomic delegation grant check + INSERT.
 * Phase 09 (plan 260910-1334) Phase 4.
 *
 * Enforces role delegation model:
 *   1. central.operator bypass — global grant, không cần can_grant match
 *   2. Grantor phải có role trong same (app, tenant) scope
 *   3. Ít nhất 1 role của grantor (self or ancestors) có target_role_key trong can_grant
 *
 * CRITICAL race window fix (red team #2): Check + INSERT trong 1 transaction với
 *   FOR UPDATE lock trên grantor's user_grants → chống concurrent revoke leaked grant.
 *
 * Deadlock retry (2 concurrent grants swap → lock cycle): retry với jittered backoff, max 3.
 */
import type { PoolClient } from 'pg';
import { writerPool } from '../db/writer-pool.js';
import { expandRoleHierarchy } from '../lib/expand-role-hierarchy.js';
import { logger } from '../lib/logger.js';

export interface DelegationCheckResult {
  allow: boolean;
  reason?: string;
  grantId?: string;
  delegationChain?: string[];
  grantorEffectiveRoles?: string[];
  centralOperatorBypass?: boolean;
}

const MAX_DEADLOCK_RETRIES = 3;

/**
 * Atomic delegation check + INSERT user_grants.
 * Returns {allow: true, grantId, delegationChain} nếu OK; {allow: false, reason} nếu reject.
 *
 * Throws only on non-recoverable errors (DB down, schema drift). Deadlock (Postgres 40P01)
 * retried automatically với jittered backoff.
 */
export async function canAssignRoleAndInsert(
  grantorSub: string,
  targetUserSub: string,
  targetRoleKey: string,
  targetTenantId: string | null,
  appSlug: string,
  retryCount = 0,
): Promise<DelegationCheckResult> {
  const client = await writerPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Resolve app_id + verify target_role belongs to app
    const appRes = await client.query<{ id: string }>(
      `SELECT id FROM rbac.apps WHERE slug = $1`,
      [appSlug],
    );
    if (appRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { allow: false, reason: 'app_not_found' };
    }
    const appId = appRes.rows[0]!.id;

    const roleRes = await client.query<{ app_id: string | null }>(
      `SELECT app_id FROM rbac.roles WHERE key = $1`,
      [targetRoleKey],
    );
    if (roleRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { allow: false, reason: 'target_role_not_found' };
    }
    if (roleRes.rows[0]!.app_id !== null && roleRes.rows[0]!.app_id !== appId) {
      await client.query('ROLLBACK');
      return { allow: false, reason: 'target_role_belongs_to_different_app' };
    }

    // 2. Check central.operator bypass (grantor có role central.operator = global admin)
    const operatorCheck = await client.query<{ has_operator: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM rbac.user_grants
         WHERE user_sub = $1 AND role_key = 'central.operator'
       ) AS has_operator`,
      [grantorSub],
    );
    const isOperator = operatorCheck.rows[0]?.has_operator === true;

    let allowed = false;
    let delegationChain: string[] = [];
    let grantorEffectiveRoles: string[] = [];

    if (isOperator) {
      allowed = true;
      delegationChain = ['central.operator', targetRoleKey];
      grantorEffectiveRoles = ['central.operator'];
      logger.info({ grantorSub, targetRoleKey, appSlug }, 'delegation-check: central.operator bypass');
    } else {
      // 3. LOCK grantor's grants trong same (app, tenant) scope FOR UPDATE
      //    ORDER BY id: deterministic lock order → giảm deadlock giữa concurrent grantors
      const grantorGrants = await client.query<{ role_key: string }>(
        `SELECT role_key FROM rbac.user_grants
          WHERE user_sub = $1
            AND app_id = $2
            AND (tenant_id IS NULL OR tenant_id = $3)
          ORDER BY id
          FOR UPDATE`,
        [grantorSub, appId, targetTenantId],
      );

      if (grantorGrants.rows.length === 0) {
        await client.query('ROLLBACK');
        return { allow: false, reason: 'grantor_has_no_grants_in_scope' };
      }

      const grantorRoleKeys = grantorGrants.rows.map((r) => r.role_key);
      grantorEffectiveRoles = await expandRoleHierarchy(client, grantorRoleKeys);

      // 4. Check bất kỳ role nào của grantor có target_role_key trong can_grant
      const canGrantCheck = await client.query<{ key: string; can_grant: string[] }>(
        `SELECT key, can_grant FROM rbac.roles WHERE key = ANY($1::text[])`,
        [grantorEffectiveRoles],
      );

      for (const row of canGrantCheck.rows) {
        if (row.can_grant?.includes(targetRoleKey)) {
          allowed = true;
          delegationChain = [row.key, targetRoleKey];
          break;
        }
      }
    }

    if (!allowed) {
      await client.query('ROLLBACK');
      return {
        allow: false,
        reason: 'no_role_can_grant_target',
        grantorEffectiveRoles,
      };
    }

    // 5. INSERT user_grants (idempotent qua UNIQUE constraint)
    const insertRes = await client.query<{ id: string }>(
      `INSERT INTO rbac.user_grants (user_sub, app_id, role_key, tenant_id, granted_by_sub)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_sub, app_id, role_key, tenant_id) DO NOTHING
       RETURNING id`,
      [targetUserSub, appId, targetRoleKey, targetTenantId, grantorSub],
    );

    if (insertRes.rowCount === 0) {
      // Already exists — idempotent, look up existing grant id
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM rbac.user_grants
          WHERE user_sub = $1 AND app_id = $2 AND role_key = $3
            AND (tenant_id IS NOT DISTINCT FROM $4)`,
        [targetUserSub, appId, targetRoleKey, targetTenantId],
      );
      await client.query('COMMIT');
      return {
        allow: true,
        grantId: existing.rows[0]?.id ?? 'unknown',
        delegationChain,
        grantorEffectiveRoles,
        centralOperatorBypass: isOperator,
      };
    }

    await client.query('COMMIT');
    return {
      allow: true,
      grantId: insertRes.rows[0]!.id,
      delegationChain,
      grantorEffectiveRoles,
      centralOperatorBypass: isOperator,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Postgres deadlock detected — retry with jittered backoff
    const pgErr = err as { code?: string };
    if (pgErr.code === '40P01' && retryCount < MAX_DEADLOCK_RETRIES) {
      const backoffMs = 100 + Math.random() * 100;
      logger.warn(
        { grantorSub, targetRoleKey, retryCount, backoffMs },
        'delegation-check: deadlock detected, retrying with backoff',
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      return canAssignRoleAndInsert(
        grantorSub,
        targetUserSub,
        targetRoleKey,
        targetTenantId,
        appSlug,
        retryCount + 1,
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reverse check for DELETE: verify grantor có quyền revoke target grant.
 * Same rule: grantor có role với target_role_key trong can_grant OR grantor is central.operator.
 * KHÔNG cần FOR UPDATE (DELETE tự lock row).
 */
export async function canRevokeRole(
  grantorSub: string,
  targetRoleKey: string,
  appId: string,
  targetTenantId: string | null,
  client: PoolClient,
): Promise<{ allow: boolean; reason?: string }> {
  // Central operator bypass
  const opRes = await client.query<{ has_operator: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM rbac.user_grants
       WHERE user_sub = $1 AND role_key = 'central.operator'
     ) AS has_operator`,
    [grantorSub],
  );
  if (opRes.rows[0]?.has_operator === true) {
    return { allow: true };
  }

  // Fetch grantor's expanded roles trong scope
  const grantorGrants = await client.query<{ role_key: string }>(
    `SELECT role_key FROM rbac.user_grants
      WHERE user_sub = $1
        AND app_id = $2
        AND (tenant_id IS NULL OR tenant_id = $3)`,
    [grantorSub, appId, targetTenantId],
  );
  if (grantorGrants.rows.length === 0) {
    return { allow: false, reason: 'grantor_has_no_grants_in_scope' };
  }

  const grantorRoleKeys = grantorGrants.rows.map((r) => r.role_key);
  const expanded = await expandRoleHierarchy(client, grantorRoleKeys);

  const canGrantCheck = await client.query<{ can_grant: string[] }>(
    `SELECT can_grant FROM rbac.roles WHERE key = ANY($1::text[])`,
    [expanded],
  );
  const canRevoke = canGrantCheck.rows.some((r) => r.can_grant?.includes(targetRoleKey));
  return canRevoke ? { allow: true } : { allow: false, reason: 'no_role_can_revoke_target' };
}
