/**
 * auth-resolve.ts — Auth guard for /v1/resolve endpoint.
 * Accepts EITHER:
 *   1. X-Rbac-Token header (constant-time compare vs CENTRAL_RBAC_RESOLVE_TOKEN)
 *   2. zitadel-signature header (HMAC-SHA256, format: t=<ts>,v1=<hex>)
 * Rejects with 401 in ALL environments — no skip logic.
 *
 * C2 fix: HMAC verified over request.rawBody (exact bytes Zitadel signed),
 *         not over JSON.stringify(request.body) which re-serializes with
 *         different key order/whitespace than the original payload.
 * H3 fix: Reject future timestamps beyond SMALL_SKEW_MS (60s), not just past.
 * H4 fix: Header parser splits on first '=' only; validates hex sig format.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { constantTimeCompare } from '../lib/constant-time-compare.js';

// HMAC signature replay window: 5 minutes past
const HMAC_WINDOW_MS = 5 * 60 * 1000;
// Max clock skew allowed for future-dated timestamps (H3): 60 seconds
const HMAC_FUTURE_SKEW_MS = 60 * 1000;
// Expected hex signature length (SHA-256 → 64 hex chars)
const HEX_SIG_RE = /^[a-f0-9]{64}$/;

interface ParsedSigHeader {
  ts: string;
  sig: string;
}

/**
 * Parse `t=<ts>,v1=<hex>` header.
 * Splits each token on the FIRST '=' only to handle base64 padding if
 * Zitadel ever switches format (H4 fix). Validates hex format of sig.
 * Returns null on any parse failure.
 */
function parseSigHeader(header: string): ParsedSigHeader | null {
  const kvMap: Record<string, string> = {};

  for (const token of header.split(',')) {
    const trimmed = token.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return null; // malformed token
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    kvMap[key] = value;
  }

  const ts = kvMap['t'];
  const sig = kvMap['v1'];

  if (!ts || !sig) return null;
  // Validate sig is a 64-char hex string (H4 fix: reject non-hex before Buffer.from)
  if (!HEX_SIG_RE.test(sig)) return null;

  return { ts, sig };
}

/**
 * Verify Zitadel-style HMAC signature.
 * Signed payload: `<timestamp>.<raw_body_utf8>`
 * raw_body MUST be the original bytes from the HTTP request (not re-serialized).
 */
function verifyHmacSignature(
  header: string,
  rawBody: Buffer,
  signingKey: string,
): boolean {
  const parsed = parseSigHeader(header);
  if (!parsed) return false;

  const { ts, sig } = parsed;
  const tsMs = parseInt(ts, 10) * 1000;

  if (Number.isNaN(tsMs)) {
    logger.warn({ ts }, 'auth-resolve: HMAC timestamp is not a number');
    return false;
  }

  const now = Date.now();

  // H3 fix: reject future timestamps beyond small clock-skew tolerance.
  // Future-dated sigs are almost always attack indicators (pre-computed replay).
  if (tsMs > now + HMAC_FUTURE_SKEW_MS) {
    logger.warn({ ts, diff: tsMs - now }, 'auth-resolve: HMAC timestamp too far in future');
    return false;
  }

  // Reject replayed past signatures beyond 5-minute window.
  if (now - tsMs > HMAC_WINDOW_MS) {
    logger.warn({ ts }, 'auth-resolve: HMAC timestamp outside replay window');
    return false;
  }

  // C2 fix: sign over `<ts>.<rawBody>` where rawBody is the exact bytes received.
  // Do NOT use JSON.stringify(request.body) — re-serialization changes key order.
  const tsPrefix = Buffer.from(`${ts}.`, 'utf8');
  const payload = Buffer.concat([tsPrefix, rawBody]);
  const expected = createHmac('sha256', signingKey).update(payload).digest('hex');

  // Timing-safe compare (both are 64 hex chars — same length guaranteed by HEX_SIG_RE)
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(sig, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;

  return timingSafeEqual(expectedBuf, actualBuf);
}

export async function verifyResolveAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Mode 1: shared token via X-Rbac-Token
  const rbacToken = request.headers['x-rbac-token'];
  if (typeof rbacToken === 'string') {
    if (constantTimeCompare(rbacToken, config.CENTRAL_RBAC_RESOLVE_TOKEN)) {
      return; // authorized
    }
    logger.warn('auth-resolve: X-Rbac-Token mismatch');
    return reply.status(401).send({ error: 'Invalid X-Rbac-Token' });
  }

  // Mode 2: HMAC via zitadel-signature header
  const sigHeader = request.headers['zitadel-signature'];
  if (typeof sigHeader === 'string') {
    // rawBody is set by the content-type parser in app.ts (C2 fix).
    // Fall back to empty buffer if somehow missing (should not happen in prod).
    const rawBody: Buffer = request.rawBody ?? Buffer.alloc(0);
    if (verifyHmacSignature(sigHeader, rawBody, config.ZITADEL_ACTION_SIGNING_KEY)) {
      return; // authorized
    }
    logger.warn('auth-resolve: HMAC signature invalid');
    return reply.status(401).send({ error: 'Invalid zitadel-signature' });
  }

  // Neither header present
  logger.warn({ url: request.url }, 'auth-resolve: no auth header on /v1/resolve');
  return reply.status(401).send({ error: 'X-Rbac-Token or zitadel-signature required' });
}
