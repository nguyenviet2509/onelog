/**
 * audit-log.ts — Audit logging middleware for mutation routes.
 * Hooks into onSend to capture request/response, writes via writer pool.
 * Dual-writes to VictoriaLogs stream rbac-audit via vl-audit-sync.
 */
import type { FastifyRequest } from 'fastify';
import { writerPool } from '../db/writer-pool.js';
import { insertAuditEntry } from '../db/queries/audit.js';
import { sendToVictoriaLogs } from './vl-audit-sync.js';
import { logger } from '../lib/logger.js';
import { incrementAuditWriteFailures } from '../lib/audit-metrics.js';
import type { JwtClaims } from './auth-jwt.js';

export interface AuditContext {
  action: string;
  target_type: string;
  target_id: string;
  before_state?: unknown;
  after_state?: unknown;
}

declare module 'fastify' {
  interface FastifyRequest {
    auditCtx?: AuditContext;
  }
}

/**
 * writeAuditLog — call from route handlers after successful mutation.
 * Extracts actor from request.jwtClaims; falls back to 'unknown' for
 * service-account callers (resolve endpoint uses token auth, not JWT).
 */
export async function writeAuditLog(
  request: FastifyRequest,
  ctx: AuditContext,
): Promise<void> {
  const claims = request.jwtClaims as JwtClaims | undefined;
  const actor_id = claims?.sub ?? 'service';
  const actor_email = (claims?.['email'] as string | undefined) ?? '';
  const actor_type = claims ? 'user' : 'service';

  // Cap before/after at 8KB to prevent JSONB bloat
  const MAX_JSON_BYTES = 8 * 1024;
  function capJson(val: unknown): unknown {
    if (val == null) return null;
    const s = JSON.stringify(val);
    return s.length > MAX_JSON_BYTES ? { __truncated: true, size: s.length } : val;
  }

  try {
    const entry = await insertAuditEntry(writerPool, {
      actor_id,
      actor_type,
      actor_email,
      action: ctx.action,
      target_type: ctx.target_type,
      target_id: ctx.target_id,
      before_state: capJson(ctx.before_state),
      after_state: capJson(ctx.after_state),
      ip: request.ip,
      session_id: claims?.['session_id'] as string | undefined,
      correlation_id: request.id,
    });

    // Dual-write to VL (non-blocking — failures logged, not thrown)
    sendToVictoriaLogs(entry).catch((err) => {
      logger.error({ err }, 'audit-log: VL dual-write failed');
    });
  } catch (err) {
    // Audit write failure must NOT be swallowed silently.
    // Log at ERROR level AND increment in-process counter (visible on /v1/health).
    // Phase 2: replace counter with prom-client `rbac_audit_write_failures_total`.
    logger.error({ err, action: ctx.action }, 'audit-log: failed to write audit entry');
    incrementAuditWriteFailures();
  }
}
