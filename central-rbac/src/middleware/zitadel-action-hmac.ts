/**
 * zitadel-action-hmac.ts — HMAC verification middleware for Zitadel Action webhook calls.
 *
 * ## Confirmed Algorithm (from Zitadel v4.16.1 source: pkg/actions/signing.go)
 *
 * ```go
 * func computeSignature(t time.Time, payload []byte, signingKey string) []byte {
 *   mac := hmac.New(sha256.New, []byte(signingKey))
 *   mac.Write([]byte(fmt.Sprintf("%d", t.Unix())))
 *   mac.Write([]byte("."))
 *   mac.Write(payload)
 *   return mac.Sum(nil)
 * }
 * ```
 *
 * Algorithm: HMAC-SHA256(key_as_utf8_bytes, unix_timestamp_string + "." + raw_body_bytes)
 * Header:    ZITADEL-Signature: t=<unix_ts>,v1=<hex_sha256>
 * Key:       Raw UTF-8 string from Zitadel Console signing key field (no base64/hex decode)
 *
 * Note: Header name on the wire is lowercase `zitadel-signature` (HTTP/1.1 canonical).
 * The Zitadel source constant is "ZITADEL-Signature" which is the canonical form.
 *
 * Day 2 resolution: spike-webhook used the correct formula. The Day 1 failure was
 * most likely a key mismatch (wrong key value in container env vs Console). The
 * formula ts + "." + rawBody is confirmed correct by Zitadel source.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// Replay window: 5 minutes past
const HMAC_WINDOW_MS = 5 * 60 * 1000;
// Max acceptable future clock skew: 60 seconds
const HMAC_FUTURE_SKEW_MS = 60 * 1000;
// SHA-256 produces 32 bytes → 64 hex chars
const HEX_SIG_RE = /^[a-f0-9]{64}$/;

interface ParsedSigHeader {
  ts: string;
  sig: string;
}

function parseSigHeader(header: string): ParsedSigHeader | null {
  const kvMap: Record<string, string> = {};
  for (const token of header.split(',')) {
    const trimmed = token.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return null;
    kvMap[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  const { t: ts, v1: sig } = kvMap;
  if (!ts || !sig) return null;
  if (!HEX_SIG_RE.test(sig)) return null;
  return { ts, sig };
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verify a Zitadel action webhook HMAC signature.
 *
 * @param rawBody         Exact bytes from the HTTP request (not re-serialized JSON)
 * @param signatureHeader Value of the `zitadel-signature` header
 * @param signingKey      Raw UTF-8 signing key from Zitadel Console (not base64/hex decoded)
 */
export function verifyZitadelSignature(
  rawBody: Buffer,
  signatureHeader: string,
  signingKey: string,
): VerifyResult {
  const keyConfigured = Boolean(signingKey);
  if (!keyConfigured) {
    logger.warn({ keyConfigured: false }, 'zitadel-hmac: signing key not configured');
    return { valid: false, reason: 'signing_key_not_configured' };
  }

  const parsed = parseSigHeader(signatureHeader);
  if (!parsed) {
    return { valid: false, reason: 'header_parse_failed' };
  }

  const { ts, sig } = parsed;
  const tsMs = parseInt(ts, 10) * 1000;
  if (Number.isNaN(tsMs)) {
    return { valid: false, reason: 'timestamp_not_a_number' };
  }

  const now = Date.now();
  if (tsMs > now + HMAC_FUTURE_SKEW_MS) {
    logger.warn({ diff: tsMs - now }, 'zitadel-hmac: timestamp too far in future');
    return { valid: false, reason: 'timestamp_future' };
  }
  if (now - tsMs > HMAC_WINDOW_MS) {
    logger.warn({ ageMs: now - tsMs }, 'zitadel-hmac: timestamp outside replay window');
    return { valid: false, reason: 'timestamp_expired' };
  }

  // Compute: HMAC-SHA256(key_utf8, ts_string + "." + rawBody)
  const mac = createHmac('sha256', signingKey);
  mac.update(`${ts}.`);
  mac.update(rawBody);
  const expected = mac.digest('hex');

  // Timing-safe compare
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(sig, 'hex');
  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, reason: 'sig_length_mismatch' };
  }

  const valid = timingSafeEqual(expectedBuf, actualBuf);
  logger.debug(
    { keyConfigured: true, algorithm: 'HMAC-SHA256', valid },
    'zitadel-hmac: verification complete',
  );
  return { valid, reason: valid ? undefined : 'sig_mismatch' };
}

/**
 * Fastify preHandler — reject with 401 if HMAC invalid.
 * Reads rawBody set by app.ts content-type parser.
 */
export async function verifyZitadelActionHmac(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sigHeader = request.headers['zitadel-signature'];
  if (typeof sigHeader !== 'string' || sigHeader.trim() === '') {
    logger.warn({ url: request.url }, 'zitadel-hmac: missing zitadel-signature header');
    return reply.status(401).send({ error: 'Missing zitadel-signature header' });
  }

  const rawBody = request.rawBody ?? Buffer.alloc(0);
  const result = verifyZitadelSignature(rawBody, sigHeader, config.ZITADEL_ACTION_SIGNING_KEY);

  if (!result.valid) {
    logger.warn(
      { reason: result.reason, url: request.url },
      'zitadel-hmac: signature rejected',
    );
    return reply.status(401).send({ error: 'Invalid zitadel-signature', reason: result.reason });
  }
}
