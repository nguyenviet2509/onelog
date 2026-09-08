/**
 * routes/audit-ingest.ts — POST /v1/audit/ingest
 * External apps push audit events into central RBAC audit_log.
 * Auth: static bearer token via AUDIT_INGEST_TOKENS (app_id derived from token).
 * Writes go through insertAuditEntry → same hash-chain + immutable trigger as
 * internal rbac events. app_id column tags source app for UI filter.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writerPool } from '../db/writer-pool.js';
import { insertAuditEntry } from '../db/queries/audit.js';
import { verifyIngestToken, isIngestEnabled } from '../lib/audit-ingest-tokens.js';
import { logger } from '../lib/logger.js';
import { sendToVictoriaLogs } from '../middleware/vl-audit-sync.js';
import { incrementAuditWriteFailures } from '../lib/audit-metrics.js';

// Body capped roughly: state fields limited server-side to 8KB each (queries/audit.ts)
// but reject at ingress if raw request is absurd (>64KB) to save DB round-trip.
const MAX_BODY_BYTES = 64 * 1024;

const ingestSchema = z.object({
  action: z.string().min(1).max(128),
  target_type: z.string().min(1).max(64),
  target_id: z.string().min(1).max(128),
  actor_id: z.string().min(1).max(128).default('service'),
  actor_type: z.enum(['user', 'service']).default('service'),
  actor_email: z.string().max(256).default(''),
  before_state: z.unknown().optional(),
  after_state: z.unknown().optional(),
  ip: z.string().max(64).optional(),
  session_id: z.string().max(128).optional(),
  correlation_id: z.string().max(128).optional(),
  ts: z.string().datetime({ offset: true }).optional(), // logged only; server always uses now()
});

// Cap before/after at 8KB inside the ingest route so payload bloat can't
// consume writer connections. Matches internal middleware cap.
const MAX_JSON_BYTES = 8 * 1024;
function capJson(val: unknown): unknown {
  if (val == null) return null;
  const s = JSON.stringify(val);
  return s.length > MAX_JSON_BYTES ? { __truncated: true, size: s.length } : val;
}

export async function auditIngestRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/audit/ingest',
    {
      bodyLimit: MAX_BODY_BYTES,
    },
    async (request, reply) => {
      if (!isIngestEnabled()) {
        return reply.status(503).send({ error: 'audit ingress disabled (AUDIT_INGEST_TOKENS empty)' });
      }

      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing Bearer token' });
      }
      const appId = verifyIngestToken(authHeader.slice(7));
      if (!appId) {
        logger.warn({ ip: request.ip }, 'audit-ingest: token rejected');
        return reply.status(401).send({ error: 'Invalid ingest token' });
      }

      const parsed = ingestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
      }
      const d = parsed.data;

      try {
        const entry = await insertAuditEntry(writerPool, {
          actor_id: d.actor_id,
          actor_type: d.actor_type,
          actor_email: d.actor_email,
          action: d.action,
          target_type: d.target_type,
          target_id: d.target_id,
          before_state: capJson(d.before_state),
          after_state: capJson(d.after_state),
          ip: d.ip ?? request.ip,
          session_id: d.session_id,
          correlation_id: d.correlation_id ?? request.id,
          app_id: appId,
        });

        // Dual-write to VictoriaLogs (non-blocking)
        sendToVictoriaLogs(entry).catch((err) => {
          logger.error({ err, app_id: appId }, 'audit-ingest: VL dual-write failed');
        });

        return reply.status(201).send({ id: entry.id, seq: entry.seq, ts: entry.ts });
      } catch (err) {
        logger.error({ err, app_id: appId, action: d.action }, 'audit-ingest: DB write failed');
        incrementAuditWriteFailures();
        return reply.status(500).send({ error: 'audit write failed' });
      }
    },
  );
}
