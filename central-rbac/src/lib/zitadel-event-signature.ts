/**
 * zitadel-event-signature.ts — Verify Zitadel Actions v2 Target signature.
 *
 * Zitadel signs the request body with HMAC-SHA256 using a shared secret
 * displayed once when the Target is created. Header format (v4.x):
 *
 *   ZITADEL-Signature: t=<unix-ts>,v1=<hex-hmac>
 *
 * (Header name is case-insensitive per HTTP spec.)
 *
 * We recompute `HMAC-SHA256(key, `${t}.${raw_body}`)` and compare in
 * constant-time. Optional 5-min freshness window guards against replay.
 *
 * If Zitadel changes header format between versions, adjust the parser here.
 * A raw dump is logged (info-level, once per bad signature) to aid debugging.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_SEC = 5 * 60;

export interface SignatureCheckResult {
  ok: boolean;
  reason?: string;
}

interface ParsedHeader {
  t: number;
  v1: string;
}

function parseHeader(header: string): ParsedHeader | null {
  // Accept either `t=...,v1=...` scheme or plain hex fallback.
  const parts = header.split(',').map((p) => p.trim());
  let t: number | undefined;
  let v1: string | undefined;
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === 't') t = Number(v);
    else if (k === 'v1') v1 = v;
  }
  if (typeof t === 'number' && Number.isFinite(t) && v1) return { t, v1 };
  // Fallback: whole header is the hex sig (no timestamp) — accept if key set.
  if (/^[a-f0-9]{64}$/i.test(header.trim())) {
    return { t: Math.floor(Date.now() / 1000), v1: header.trim() };
  }
  return null;
}

export function verifyZitadelEventSignature(
  key: string,
  rawBody: Buffer | string,
  headerVal: string | undefined,
  now: number = Math.floor(Date.now() / 1000),
): SignatureCheckResult {
  if (!key) return { ok: false, reason: 'signing_key_not_configured' };
  if (!headerVal) return { ok: false, reason: 'missing_signature_header' };

  const parsed = parseHeader(headerVal);
  if (!parsed) return { ok: false, reason: 'unparseable_signature_header' };

  // Freshness — reject stale signatures (replay protection)
  if (Math.abs(now - parsed.t) > MAX_AGE_SEC) {
    return { ok: false, reason: 'signature_too_old' };
  }

  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signedPayload = `${parsed.t}.${bodyStr}`;
  const expected = createHmac('sha256', key).update(signedPayload, 'utf8').digest('hex');

  let sigBuf: Buffer;
  let expBuf: Buffer;
  try {
    sigBuf = Buffer.from(parsed.v1, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch {
    return { ok: false, reason: 'invalid_hex_signature' };
  }
  if (sigBuf.length !== expBuf.length) {
    return { ok: false, reason: 'signature_length_mismatch' };
  }
  if (!timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}
