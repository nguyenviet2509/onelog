/**
 * routes/zitadel-event-webhook.ts — POST /v1/webhooks/zitadel-event
 *
 * Adapter: Zitadel Actions v2 Target callbacks (Condition = "all" fires ALL events)
 * → filtered whitelist → map → audit_log with app_id='zitadel'.
 *
 * Auth: HMAC-SHA256 signature via ZITADEL_EVENT_SIGNING_KEY (Target's signingKey).
 *
 * Zitadel v4 payload keys are snake_case (event_type, event_payload, created_at)
 * — verified 2026-09-08 via debug dump.
 *
 * Whitelist strategy: Zitadel emits ~7 events per login (auth_request.*, oidc_session.*).
 * We only insert audit rows for events that map to user-visible facts (login/logout/mfa),
 * silently 200-OK the rest to keep audit UI clean.
 *
 * App enrichment: event_payload.client_id (Zitadel OIDC app client_id) → app slug
 * via CLIENT_ID_TO_APP registry. Extend when new app onboarded to Zitadel.
 */
import type { FastifyInstance } from 'fastify';
import { writerPool } from '../db/writer-pool.js';
import { insertAuditEntry } from '../db/queries/audit.js';
import { sendToVictoriaLogs } from '../middleware/vl-audit-sync.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { verifyZitadelEventSignature } from '../lib/zitadel-event-signature.js';
import { resolveAppSlug, resolveUserEmail } from '../lib/zitadel-event-enrichment.js';
import { incrementAuditWriteFailures } from '../lib/audit-metrics.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 8 * 1024;
function capJson(val: unknown): unknown {
  if (val == null) return null;
  const s = JSON.stringify(val);
  return s.length > MAX_JSON_BYTES ? { __truncated: true, size: s.length } : val;
}

interface ZitadelEventBody {
  aggregateID?: string;
  aggregateType?: string;
  resourceOwner?: string;
  instanceID?: string;
  sequence?: number | string;
  event_type?: string;
  created_at?: string;
  userID?: string;
  editorUser?: string;
  event_payload?: Record<string, unknown> | null;
}

// Whitelist: Zitadel event_type → central audit action name.
// Non-listed events return 200 without DB insert (drop-silently, keep UI clean).
const EVENT_ACTION_MAP: Record<string, string> = {
  'oidc_session.added': 'user.login',
  'session.added': 'user.login',
  'oidc_session.terminated': 'user.logout',
  'session.terminated': 'user.logout',
  'oidc_session.access_token.revoked': 'user.token.revoked',
  'user.human.password.check.succeeded': 'user.password.verified',
  'user.human.password.check.failed': 'user.password.failed',
  'user.human.mfa.otp.check.succeeded': 'user.mfa.verified',
  'user.human.mfa.otp.check.failed': 'user.mfa.failed',
  'user.locked': 'user.locked',
  'user.unlocked': 'user.unlocked',
  'user.added': 'user.created',
  'user.removed': 'user.deleted',
};

// App slug resolution is dynamic via resolveAppSlug() → rbac.apps table with
// Redis cache. Newly-registered apps (Central RBAC wizard writes
// zitadel_client_id) tự động available sau cache TTL 10 phút. Zero hardcode.

function extractZitadelIp(payload: Record<string, unknown> | null | undefined): string | undefined {
  if (!payload) return undefined;
  // Zitadel v4 nests IP in userAgent.ip (oidc_session events verified 2026-09-08).
  const ua = payload['userAgent'] as Record<string, unknown> | undefined;
  if (ua && typeof ua['ip'] === 'string') return ua['ip'];
  // Fallback shallow paths
  if (typeof payload['ip'] === 'string') return payload['ip'];
  return undefined;
}

function extractClientId(payload: Record<string, unknown> | null | undefined): string | undefined {
  if (!payload) return undefined;
  // oidc_session events: client_id at top of payload
  // auth_request events: also client_id
  const v = payload['client_id'] ?? payload['clientID'];
  return typeof v === 'string' ? v : undefined;
}

function extractUserID(body: ZitadelEventBody): string {
  const p = body.event_payload ?? {};
  // Top-level userID (from event envelope)
  if (body.userID && body.userID !== 'SYSTEM') return body.userID;
  // Payload user id fields (oidc_session, session, auth_request.session.linked)
  const candidates = [p['userID'], p['user_id'], p['userId']];
  for (const c of candidates) {
    if (typeof c === 'string' && c !== 'SYSTEM') return c;
  }
  return body.userID ?? 'unknown';
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
        logger.info(
          { reason: check.reason, header_present: Boolean(sigHeader) },
          'zitadel-event: signature invalid',
        );
        return reply.status(401).send({ error: 'invalid signature', reason: check.reason });
      }

      const body = (request.body ?? {}) as ZitadelEventBody;
      const eventType = body.event_type ?? 'unknown';

      // Drop-silently: not in whitelist. Return 200 to keep Zitadel happy.
      const baseAction = EVENT_ACTION_MAP[eventType];
      if (!baseAction) {
        return reply.status(200).send({ ok: true, dropped: true, event_type: eventType });
      }

      const aggregateID = body.aggregateID ?? 'unknown';
      const aggregateType = body.aggregateType ?? 'unknown';
      const userID = extractUserID(body);
      const clientId = extractClientId(body.event_payload);

      // Enrich (both cached — first-hit adds ~50ms Zitadel API, subsequent 0ms):
      //   appSlug   ← rbac.apps table by client_id (10 min TTL)
      //   userEmail ← Zitadel /v2/users/:id (24h TTL)
      const [appSlug, userEmail] = await Promise.all([
        resolveAppSlug(clientId),
        resolveUserEmail(userID, body.resourceOwner),
      ]);

      // Encode app slug into action if resolved: user.login.onemcp
      const action = appSlug ? `${baseAction}.${appSlug}` : baseAction;

      try {
        const entry = await insertAuditEntry(writerPool, {
          actor_id: userID,
          actor_type: userID === 'SYSTEM' || userID === 'unknown' ? 'service' : 'user',
          actor_email: userEmail ?? '',
          action,
          target_type: aggregateType,
          target_id: aggregateID,
          before_state: null,
          after_state: capJson({
            event_type: eventType,
            aggregate_type: aggregateType,
            resource_owner: body.resourceOwner,
            sequence: body.sequence,
            created_at: body.created_at,
            client_id: clientId,
            app_slug: appSlug,
            event_payload: body.event_payload,
          }),
          // ip: Zitadel event_payload.userAgent.ip khi có (verified 2026-09-08).
          // Warning: cho OIDC OAuth flow (VD OneMCP), giá trị này là IP hop cuối
          // gọi Zitadel (thường là backend server-to-server), KHÔNG phải browser
          // IP. Cho flow login trực tiếp qua Zitadel Console → là browser IP.
          // UI drawer có thể hiển thị note.
          ip: extractZitadelIp(body.event_payload),
          session_id:
            (body.event_payload?.['sessionID'] as string | undefined) ??
            (body.event_payload?.['session_id'] as string | undefined) ??
            (aggregateType === 'session' ? aggregateID : undefined),
          correlation_id: request.id,
          app_id: 'zitadel',
        });

        sendToVictoriaLogs(entry).catch((err) => {
          logger.error({ err }, 'zitadel-event: VL dual-write failed');
        });

        return reply.status(200).send({ ok: true, id: entry.id, action });
      } catch (err) {
        logger.error({ err, eventType, aggregateID }, 'zitadel-event: DB write failed');
        incrementAuditWriteFailures();
        return reply.status(500).send({ error: 'audit write failed' });
      }
    },
  );
}
