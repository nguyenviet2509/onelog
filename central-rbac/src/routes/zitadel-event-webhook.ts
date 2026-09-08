/**
 * routes/zitadel-event-webhook.ts — POST /v1/webhooks/zitadel-event
 *
 * Adapter: receives Zitadel Actions v2 Target callbacks (session/user events)
 * and maps to central audit_log format. Different from /v1/audit/ingest which
 * expects our own schema — this endpoint accepts Zitadel's fixed payload.
 *
 * Auth: HMAC-SHA256 signature verification via ZITADEL_EVENT_SIGNING_KEY.
 * Central-imposed app_id = 'zitadel'.
 *
 * Event mapping table (extend as new event types matter):
 *   session.added                          → user.login
 *   session.terminated                     → user.logout
 *   user.human.password.check.succeeded    → user.password.verified
 *   otherwise                              → zitadel.<eventType>
 *
 * Not-verified events still get inserted with best-effort mapping — audit
 * completeness > event type coverage.
 */
import type { FastifyInstance } from 'fastify';
import { writerPool } from '../db/writer-pool.js';
import { insertAuditEntry } from '../db/queries/audit.js';
import { sendToVictoriaLogs } from '../middleware/vl-audit-sync.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { verifyZitadelEventSignature } from '../lib/zitadel-event-signature.js';
import { incrementAuditWriteFailures } from '../lib/audit-metrics.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 8 * 1024;
function capJson(val: unknown): unknown {
  if (val == null) return null;
  const s = JSON.stringify(val);
  return s.length > MAX_JSON_BYTES ? { __truncated: true, size: s.length } : val;
}

// Zitadel v4 Action v2 payload shape (best-effort — union across event types).
// Undocumented fields tolerated — we extract what we can.
interface ZitadelEventBody {
  aggregateID?: string;
  aggregateType?: string;
  resourceOwner?: string;
  instanceID?: string;
  sequence?: number | string;
  eventType?: string;
  createdAt?: string;
  userID?: string;
  editorUser?: string;
  eventPayload?: Record<string, unknown> | null;
  // Some Zitadel schemas wrap event in `event`:
  event?: Partial<ZitadelEventBody>;
  // Actions v2 may nest as `request` too:
  request?: Partial<ZitadelEventBody>;
}

function pickEventType(body: ZitadelEventBody): string {
  return body.eventType ?? body.event?.eventType ?? body.request?.eventType ?? 'unknown';
}

function pickAggregateID(body: ZitadelEventBody): string {
  return (
    body.aggregateID ?? body.event?.aggregateID ?? body.request?.aggregateID ?? 'unknown'
  );
}

function pickAggregateType(body: ZitadelEventBody): string {
  return (
    body.aggregateType ?? body.event?.aggregateType ?? body.request?.aggregateType ?? 'unknown'
  );
}

function pickUserID(body: ZitadelEventBody): string {
  const p = (body.eventPayload as Record<string, unknown> | undefined) ?? {};
  const uid = body.userID ?? body.editorUser ?? body.event?.userID ?? body.request?.userID;
  if (uid) return String(uid);
  // Session events keep userID inside payload.userId
  const nested = p['userId'] ?? p['userID'];
  if (typeof nested === 'string') return nested;
  return 'unknown';
}

function mapEventTypeToAction(eventType: string): string {
  if (eventType === 'session.added') return 'user.login';
  if (eventType === 'session.terminated') return 'user.logout';
  if (eventType === 'user.human.password.check.succeeded') return 'user.password.verified';
  if (eventType === 'user.human.mfa.otp.check.succeeded') return 'user.mfa.verified';
  return `zitadel.${eventType}`;
}

export async function zitadelEventWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/webhooks/zitadel-event',
    { bodyLimit: MAX_BODY_BYTES },
    async (request, reply) => {
      const key = config.ZITADEL_EVENT_SIGNING_KEY;
      if (!key) {
        return reply.status(503).send({ error: 'zitadel event webhook disabled (no signing key)' });
      }

      // rawBody captured by content-type parser in app.ts (Buffer)
      const raw = request.rawBody;
      if (!raw) {
        logger.warn('zitadel-event: rawBody missing — content-type parser mis-configured');
        return reply.status(400).send({ error: 'raw body unavailable' });
      }

      const sigHeader =
        (request.headers['zitadel-signature'] as string | undefined) ??
        (request.headers['x-zitadel-signature'] as string | undefined);
      const check = verifyZitadelEventSignature(key, raw, sigHeader);
      if (!check.ok) {
        // Log at info: helps debug first setup without spamming errors
        logger.info(
          { reason: check.reason, header_present: Boolean(sigHeader), header_names: Object.keys(request.headers).filter((h) => h.toLowerCase().includes('sig')) },
          'zitadel-event: signature invalid',
        );
        return reply.status(401).send({ error: 'invalid signature', reason: check.reason });
      }

      const body = (request.body ?? {}) as ZitadelEventBody;
      const eventType = pickEventType(body);
      const aggregateID = pickAggregateID(body);
      const aggregateType = pickAggregateType(body);
      const userID = pickUserID(body);

      const action = mapEventTypeToAction(eventType);

      try {
        const entry = await insertAuditEntry(writerPool, {
          actor_id: userID,
          actor_type: 'user',
          actor_email: '', // Zitadel event body doesn't include email; enrich phase 2 via Mgmt API
          action,
          target_type: aggregateType || 'session',
          target_id: aggregateID,
          before_state: null,
          after_state: capJson({
            eventType,
            aggregateType,
            resourceOwner: body.resourceOwner,
            sequence: body.sequence,
            eventPayload: body.eventPayload,
          }),
          ip: request.ip,
          session_id: aggregateType === 'session' ? aggregateID : undefined,
          correlation_id: request.id,
          app_id: 'zitadel',
        });

        sendToVictoriaLogs(entry).catch((err) => {
          logger.error({ err }, 'zitadel-event: VL dual-write failed');
        });

        // Return 200 fast — Zitadel Target async doesn't wait, but 200 is polite.
        return reply.status(200).send({ ok: true, id: entry.id });
      } catch (err) {
        logger.error({ err, eventType, aggregateID }, 'zitadel-event: DB write failed');
        incrementAuditWriteFailures();
        return reply.status(500).send({ error: 'audit write failed' });
      }
    },
  );
}
