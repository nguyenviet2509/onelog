/**
 * auth-mtls.ts — mTLS client cert verification middleware for Fastify.
 * Phase 06 Fix #3 (Critical): defends against CN header spoofing.
 *
 * Flow:
 *   1. Traefik terminates mTLS handshake, extracts real cert CN via passTLSClientCert
 *   2. Traefik middleware strips ANY inbound X-Client-Cert-* (anti-spoof)
 *   3. cert-header-signer sidecar HMACs the CN with rotating shared secret
 *   4. This middleware verifies:
 *      (a) X-Client-Cert-CN present
 *      (b) X-Client-Cert-Sig-Ts within replay window
 *      (c) X-Client-Cert-Sig matches HMAC-SHA256(secret, `${ts}.${cn}`)
 *      (d) OPTIONAL: cert CN matches JWT `sub` claim (Fix #3 double-check)
 *
 * Backend supports BOTH primary + secondary HMAC secrets during rotation overlap
 * (5-10 min window per rotate-cert-hmac.sh). Reject if BOTH fail.
 *
 * If X-Client-Cert-CN is missing entirely → 401 (route requires mTLS).
 * If sig invalid → 401 with distinct log line (potential spoof attempt).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../lib/logger.js';

// Replay window: 60 seconds (Traefik forwardauth stamps ts, backend accepts sig within window)
const SIG_TS_WINDOW_MS = 60 * 1000;
const HEX_SIG_RE = /^[a-f0-9]{64}$/;

// Docker secret mount paths (see rotate-cert-hmac.sh)
const CERT_HMAC_PRIMARY_PATH = process.env.CERT_HMAC_PRIMARY_PATH ?? '/run/secrets/cert_hmac';
const CERT_HMAC_SECONDARY_PATH = process.env.CERT_HMAC_SECONDARY_PATH ?? '/run/secrets/cert_hmac_prev';

declare module 'fastify' {
  interface FastifyRequest {
    mtlsClientCN?: string;
  }
}

interface HmacSecrets {
  primary: string | null;
  secondary: string | null;
  loadedAt: number;
}

let cachedSecrets: HmacSecrets | null = null;
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

function loadHmacSecrets(): HmacSecrets {
  const now = Date.now();
  if (cachedSecrets && now - cachedSecrets.loadedAt < SECRET_CACHE_TTL_MS) {
    return cachedSecrets;
  }
  const primary = existsSync(CERT_HMAC_PRIMARY_PATH)
    ? readFileSync(CERT_HMAC_PRIMARY_PATH, 'utf8').trim()
    : null;
  const secondary = existsSync(CERT_HMAC_SECONDARY_PATH)
    ? readFileSync(CERT_HMAC_SECONDARY_PATH, 'utf8').trim()
    : null;
  cachedSecrets = { primary, secondary, loadedAt: now };
  return cachedSecrets;
}

function verifySigWithSecret(secret: string, ts: string, cn: string, sig: string): boolean {
  const expected = createHmac('sha256', secret).update(`${ts}.${cn}`).digest('hex');
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

export async function verifyMtls(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const cn = request.headers['x-client-cert-cn'];
  const sig = request.headers['x-client-cert-sig'];
  const ts = request.headers['x-client-cert-sig-ts'];

  // Presence check — route requires mTLS
  if (typeof cn !== 'string' || typeof sig !== 'string' || typeof ts !== 'string') {
    logger.warn(
      { url: request.url, has_cn: !!cn, has_sig: !!sig, has_ts: !!ts },
      'auth-mtls: missing client cert headers',
    );
    return reply.status(401).send({ error: 'mTLS required' });
  }

  // Sig format validation (reject non-hex before crypto call)
  if (!HEX_SIG_RE.test(sig)) {
    logger.warn({ url: request.url }, 'auth-mtls: sig not valid hex — possible spoof');
    return reply.status(401).send({ error: 'Invalid client cert signature' });
  }

  // Timestamp window check
  const tsMs = parseInt(ts, 10) * 1000;
  if (Number.isNaN(tsMs)) {
    return reply.status(401).send({ error: 'Invalid client cert timestamp' });
  }
  const now = Date.now();
  const delta = Math.abs(now - tsMs);
  if (delta > SIG_TS_WINDOW_MS) {
    logger.warn(
      { url: request.url, delta_ms: delta },
      'auth-mtls: cert sig timestamp outside replay window',
    );
    return reply.status(401).send({ error: 'Client cert signature expired' });
  }

  // Verify HMAC signature against primary + secondary (rotation overlap support)
  const secrets = loadHmacSecrets();
  if (!secrets.primary) {
    logger.error('auth-mtls: no CERT_HMAC_PRIMARY secret available — misconfiguration');
    return reply.status(500).send({ error: 'Server auth misconfigured' });
  }

  const primaryOk = verifySigWithSecret(secrets.primary, ts, cn, sig);
  const secondaryOk = secrets.secondary
    ? verifySigWithSecret(secrets.secondary, ts, cn, sig)
    : false;

  if (!primaryOk && !secondaryOk) {
    logger.warn(
      { url: request.url, cn },
      'auth-mtls: HMAC sig invalid against BOTH primary and secondary — possible spoof',
    );
    return reply.status(401).send({ error: 'Invalid client cert signature' });
  }

  if (secondaryOk && !primaryOk) {
    // Cert signed by old secret during overlap — log for observability
    logger.info({ cn }, 'auth-mtls: cert sig verified with secondary (rotation overlap)');
  }

  request.mtlsClientCN = cn;
}

/**
 * Optional double-check: mTLS cert CN must match JWT `sub` claim.
 * Chain this AFTER verifyJwt + verifyMtls to enforce identity binding.
 * Skips gracefully if either claim missing (defense-in-depth, not sole gate).
 */
export async function verifyCertJwtCrosscheck(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const cn = request.mtlsClientCN;
  const sub = request.jwtClaims?.sub;
  if (!cn || !sub) {
    // Upstream middleware should have already rejected — belt-and-braces.
    logger.warn(
      { has_cn: !!cn, has_sub: !!sub, url: request.url },
      'auth-mtls: crosscheck missing cn or sub — upstream middleware bug?',
    );
    return reply.status(401).send({ error: 'Cert/JWT crosscheck failed' });
  }
  if (cn !== sub) {
    logger.warn(
      { cn, sub, url: request.url },
      'auth-mtls: cert CN does not match JWT sub — identity spoof attempt',
    );
    return reply.status(403).send({ error: 'Cert CN does not match token subject' });
  }
}
