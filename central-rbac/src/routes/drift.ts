/**
 * routes/drift.ts — On-demand drift detection between Central RBAC and Zitadel.
 *
 * GET /v1/drift — admin only, requires JWT auth.
 *
 * Compares:
 *   - Central rbac.roles → expected Zitadel project roles
 *   - Zitadel project roles → Central roles
 *
 * Returns { ok: bool, mismatches: [{type, expected, actual}] }
 * NOT a cron — invoke manually (weekly or on suspicion).
 *
 * Does NOT compare user grants (no Central-side user_grants table in Phase 3).
 */
import type { FastifyInstance } from 'fastify';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { listRoles } from '../db/queries/roles.js';
import { writerPool } from '../db/writer-pool.js';
import { listProjectRoles } from '../lib/zitadel-mgmt-client.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export interface DriftMismatch {
  type: 'central_only' | 'zitadel_only';
  role_key: string;
  detail: string;
}

export interface DriftResult {
  ok: boolean;
  checked_at: string;
  central_role_count: number;
  zitadel_role_count: number;
  mismatches: DriftMismatch[];
}

export async function driftRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/drift', { preHandler: [verifyJwt] }, async (_request, reply) => {
    const projectId = config.ZITADEL_PROJECT_ID;
    const orgId = config.ZITADEL_ORG_ID || '';

    if (!projectId) {
      return reply.status(503).send({
        error: 'ZITADEL_PROJECT_ID not configured — drift check unavailable',
      });
    }

    // Fetch Central roles
    let centralRoles: Array<{ key: string }>;
    try {
      centralRoles = await listRoles(writerPool);
    } catch (err) {
      logger.error({ err }, 'drift: failed to fetch central roles');
      return reply.status(500).send({ error: 'Failed to fetch Central RBAC roles' });
    }

    // Fetch Zitadel project roles
    let zitadelRoles: Array<{ roleKey: string }>;
    try {
      zitadelRoles = await listProjectRoles(projectId, orgId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, projectId }, 'drift: failed to fetch Zitadel project roles');
      return reply.status(502).send({ error: 'Failed to fetch Zitadel project roles', detail: msg });
    }

    const centralKeys = new Set(centralRoles.map((r) => r.key));
    const zitadelKeys = new Set(zitadelRoles.map((r) => r.roleKey));

    const mismatches: DriftMismatch[] = [];

    // Roles in Central but not in Zitadel
    for (const key of centralKeys) {
      if (!zitadelKeys.has(key)) {
        mismatches.push({
          type: 'central_only',
          role_key: key,
          detail: `Role '${key}' exists in Central RBAC but NOT in Zitadel project ${projectId}`,
        });
      }
    }

    // Roles in Zitadel but not in Central
    for (const key of zitadelKeys) {
      if (!centralKeys.has(key)) {
        mismatches.push({
          type: 'zitadel_only',
          role_key: key,
          detail: `Role '${key}' exists in Zitadel project ${projectId} but NOT in Central RBAC`,
        });
      }
    }

    const result: DriftResult = {
      ok: mismatches.length === 0,
      checked_at: new Date().toISOString(),
      central_role_count: centralKeys.size,
      zitadel_role_count: zitadelKeys.size,
      mismatches,
    };

    logger.info(
      { ok: result.ok, mismatchCount: mismatches.length },
      'drift: check complete',
    );

    return reply.send(result);
  });
}
