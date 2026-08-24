/**
 * auth-resolve-middleware.test.ts — Unit tests for /v1/resolve auth middleware.
 * Tests shared token and HMAC verification paths.
 *
 * C2 fix: HMAC is now signed over rawBody (Buffer), not JSON.stringify(body).
 *   - Tests pass rawBody as Buffer on the mock request.
 *   - Regression test: signing the parsed object (old behaviour) must 401.
 * H3 fix: future timestamps beyond 60s must 401.
 * H4 fix: malformed headers (extra '=', non-hex sig) must 401.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// Mock config before importing middleware
vi.mock('../../src/config.js', () => ({
  config: {
    CENTRAL_RBAC_RESOLVE_TOKEN: 'valid-token-min-16-chars',
    ZITADEL_ACTION_SIGNING_KEY: 'signing-key-min-16-chars',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    VL_INGEST_URL: undefined,
    WEBHOOK_ECHO_ENABLED: false,
    CENTRAL_RBAC_CORS_ORIGIN: '',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { verifyResolveAuth } from '../../src/middleware/auth-resolve.js';

/**
 * Build a minimal mock FastifyRequest.
 * rawBody mirrors what app.ts content-type parser populates (C2 fix).
 */
function makeRequest(
  headers: Record<string, string>,
  body: unknown = {},
  rawBody?: Buffer,
) {
  return {
    headers,
    body,
    // If rawBody not supplied, simulate the old (broken) path: no rawBody on request
    rawBody,
    url: '/v1/resolve',
    ip: '127.0.0.1',
  } as Parameters<typeof verifyResolveAuth>[0];
}

function makeReply() {
  const reply = {
    _status: 0,
    _body: null as unknown,
    status(code: number) { this._status = code; return this; },
    send(body: unknown) { this._body = body; return this; },
  };
  return reply;
}

/**
 * Build a valid HMAC header signing over rawBodyStr (the literal string bytes).
 * This matches how Zitadel signs: HMAC over `<ts>.<raw_json_body>`.
 */
function makeHmacHeader(rawBodyStr: string, key: string, tsOverrideMs?: number): string {
  const ts = Math.floor((tsOverrideMs ?? Date.now()) / 1000);
  const payload = `${ts}.${rawBodyStr}`;
  const sig = createHmac('sha256', key).update(payload, 'utf8').digest('hex');
  return `t=${ts},v1=${sig}`;
}

// ─── X-Rbac-Token mode ────────────────────────────────────────────────────────

describe('verifyResolveAuth — X-Rbac-Token mode', () => {
  it('passes with valid token', async () => {
    const req = makeRequest({ 'x-rbac-token': 'valid-token-min-16-chars' });
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(0); // no status set = pass-through
  });

  it('rejects with invalid token', async () => {
    const req = makeRequest({ 'x-rbac-token': 'wrong-token-min-16-x' });
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(401);
  });
});

// ─── HMAC mode — correct raw-body path (C2 fix) ───────────────────────────────

describe('verifyResolveAuth — HMAC mode (raw body, C2 fix)', () => {
  const rawBodyStr = '{"roles":["dept.admin"]}';
  const rawBodyBuf = Buffer.from(rawBodyStr, 'utf8');
  const body = JSON.parse(rawBodyStr) as unknown;

  it('passes with valid HMAC signed over rawBody', async () => {
    const header = makeHmacHeader(rawBodyStr, 'signing-key-min-16-chars');
    const req = makeRequest({ 'zitadel-signature': header }, body, rawBodyBuf);
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(0);
  });

  it('rejects when rawBody missing (C2 regression: no raw bytes captured)', async () => {
    // Simulates old broken path: rawBody not set, HMAC signed over raw string
    // but middleware gets no rawBody → falls back to empty buffer → mismatch → 401
    const header = makeHmacHeader(rawBodyStr, 'signing-key-min-16-chars');
    const req = makeRequest({ 'zitadel-signature': header }, body, undefined);
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('rejects when HMAC signed over JSON.stringify(parsed) instead of rawBody (C2 regression)', async () => {
    // Old broken behaviour: sign over JSON.stringify(body) — different bytes than rawBody
    // e.g. key order may differ, no space after colon vs with space, etc.
    const ts = Math.floor(Date.now() / 1000);
    const reserializedPayload = `${ts}.${JSON.stringify(body)}`;
    const sig = createHmac('sha256', 'signing-key-min-16-chars')
      .update(reserializedPayload, 'utf8')
      .digest('hex');
    const header = `t=${ts},v1=${sig}`;
    // rawBody has different bytes than JSON.stringify(body) when input has spaces/order diffs
    const differentRawBody = Buffer.from('{"roles": ["dept.admin"]}', 'utf8'); // note space after colon
    const req = makeRequest({ 'zitadel-signature': header }, body, differentRawBody);
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('rejects with wrong signing key', async () => {
    const header = makeHmacHeader(rawBodyStr, 'wrong-signing-key-xxxx');
    const req = makeRequest({ 'zitadel-signature': header }, body, rawBodyBuf);
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('rejects with expired timestamp (>5min past, replay window)', async () => {
    const staleTs = (Date.now() - 400_000); // 400s ago > 5min window
    const header = makeHmacHeader(rawBodyStr, 'signing-key-min-16-chars', staleTs);
    const req = makeRequest({ 'zitadel-signature': header }, body, rawBodyBuf);
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('rejects malformed signature header (no t= token)', async () => {
    const req = makeRequest({ 'zitadel-signature': 'not-valid-format' }, body, rawBodyBuf);
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(401);
  });
});

// ─── H3: future timestamp rejection ──────────────────────────────────────────

describe('verifyResolveAuth — H3: future timestamp rejection', () => {
  const rawBodyStr = '{"roles":["dept.admin"]}';
  const rawBodyBuf = Buffer.from(rawBodyStr, 'utf8');
  const body = JSON.parse(rawBodyStr) as unknown;

  it('rejects timestamp 6 minutes in the future (+360s)', async () => {
    const futureTs = Date.now() + 360_000; // +6 min, exceeds 60s skew tolerance
    const header = makeHmacHeader(rawBodyStr, 'signing-key-min-16-chars', futureTs);
    const req = makeRequest({ 'zitadel-signature': header }, body, rawBodyBuf);
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('accepts timestamp 30 seconds in the future (within 60s skew tolerance)', async () => {
    const nearFutureTs = Date.now() + 30_000; // +30s, within tolerance
    const header = makeHmacHeader(rawBodyStr, 'signing-key-min-16-chars', nearFutureTs);
    const req = makeRequest({ 'zitadel-signature': header }, body, rawBodyBuf);
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(0); // pass
  });
});

// ─── H4: malformed header parser ─────────────────────────────────────────────

describe('verifyResolveAuth — H4: malformed header inputs', () => {
  const rawBodyBuf = Buffer.from('{}', 'utf8');

  it('rejects header with extra "=" in v1 value (e.g. base64 padding)', async () => {
    // t=123,v1=abc=xyz — old split('=') would give ['abc', 'xyz'], losing the full value
    // New parser (indexOf first '=') correctly extracts 'abc=xyz' but it fails HEX_SIG_RE
    const header = 't=123,v1=abc=xyz';
    const req = makeRequest({ 'zitadel-signature': header }, {}, rawBodyBuf);
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('rejects header with non-hex v1 value', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=NOTAHEXSTRINGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`;
    const req = makeRequest({ 'zitadel-signature': header }, {}, rawBodyBuf);
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('rejects header missing v1 token', async () => {
    const header = 't=1234567890';
    const req = makeRequest({ 'zitadel-signature': header }, {}, rawBodyBuf);
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('rejects header missing t= token', async () => {
    const header = 'v1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const req = makeRequest({ 'zitadel-signature': header }, {}, rawBodyBuf);
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(401);
  });
});

// ─── No auth header ───────────────────────────────────────────────────────────

describe('verifyResolveAuth — no auth header', () => {
  it('rejects with 401 when no auth headers present', async () => {
    const req = makeRequest({});
    const reply = makeReply();
    await verifyResolveAuth(req, reply as never);
    expect(reply._status).toBe(401);
  });
});
