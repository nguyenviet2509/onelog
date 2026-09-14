/**
 * routes/health.ts — GET /v1/health
 * Checks writer DB, auditor DB, and Redis connections.
 * Exposes audit_write_failures in-process counter (Phase 3: replace with prom-client).
 *
 * Phase 09 (plan 260910-1334): nested `v2` key với migration 019 status + feature flags
 * + epoch trigger active check. Top-level `.status` giữ nguyên cho backward monitor compat.
 */
import type { FastifyInstance } from 'fastify';
import { checkWriterConnection, writerPool } from '../db/writer-pool.js';
import { checkAuditorConnection } from '../db/auditor-pool.js';
import { checkRedisConnection } from '../lib/redis-client.js';
import { getAuditWriteFailures } from '../lib/audit-metrics.js';
import { logger } from '../lib/logger.js';

interface V2HealthState {
  migration: number | null;
  features: {
    v2_resolve: boolean;
    delegation: boolean;
    tenant_scope: boolean;
    hierarchy_expand: boolean;
  };
  epoch_trigger_active: boolean;
}

/** Check migration 019 applied + epoch trigger exists. Best-effort — errors → false. */
async function checkV2State(): Promise<V2HealthState> {
  try {
    const [migRes, triggerRes] = await Promise.all([
      writerPool.query<{ version: number }>(
        `SELECT version FROM rbac.schema_migrations WHERE version = 19`,
      ),
      writerPool.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger WHERE tgname = 'user_grants_epoch_insert'`,
      ),
    ]);

    const migrationApplied = migRes.rows.length > 0;
    const triggerActive = triggerRes.rows.length > 0;

    return {
      migration: migrationApplied ? 19 : null,
      features: {
        v2_resolve: migrationApplied && triggerActive,
        delegation: migrationApplied,
        tenant_scope: migrationApplied,
        hierarchy_expand: migrationApplied,
      },
      epoch_trigger_active: triggerActive,
    };
  } catch (err) {
    logger.warn({ err }, 'health: v2 state check failed — reporting degraded');
    return {
      migration: null,
      features: {
        v2_resolve: false,
        delegation: false,
        tenant_scope: false,
        hierarchy_expand: false,
      },
      epoch_trigger_active: false,
    };
  }
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/health', async (_request, reply) => {
    const [writer, auditor, redisOk, v2] = await Promise.all([
      checkWriterConnection(),
      checkAuditorConnection(),
      checkRedisConnection(),
      checkV2State(),
    ]);

    const auditFailures = getAuditWriteFailures();
    // Redis degraded is non-fatal — app still works without cache (slower)
    const ok = writer && auditor;
    const status = ok ? 200 : 503;

    return reply.status(status).send({
      status: ok ? 'ok' : 'degraded',
      checks: {
        db_writer: writer ? 'ok' : 'fail',
        db_auditor: auditor ? 'ok' : 'fail',
        redis: redisOk ? 'ok' : 'degraded',
        audit_write_failures: auditFailures,
      },
      v2,
      ts: new Date().toISOString(),
    });
  });
}
