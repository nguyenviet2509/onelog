/**
 * auth-jwt-middleware.test.ts — Unit tests for JWT verification middleware.
 * Uses static RSA key pair for signing/verifying without live JWKS.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK } from 'jose';
import { SignJWT } from 'jose';

// Mock config
vi.mock('../../src/config.js', () => ({
  config: {
    ZITADEL_ISSUER: 'https://authway.test',
    ZITADEL_JWKS_URL: 'https://authway.test/oauth/v2/keys',
    ZITADEL_AUD_CLIENT_ID: 'central-rbac-ui@project1',
    ZITADEL_AZP_ADMIN_CLIENT_ID: 'central-rbac-admin@project1',
    CENTRAL_RBAC_RESOLVE_TOKEN: 'valid-token-min-16-chars',
    ZITADEL_ACTION_SIGNING_KEY: 'signing-key-min-16-chars',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    VL_INGEST_URL: undefined,
    WEBHOOK_ECHO_ENABLED: false,
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// We'll mock createRemoteJWKSet to use our in-memory key
let privateKey: CryptoKey;
let publicKey: CryptoKey;

vi.mock('jose', async (importOriginal) => {
  const original = await importOriginal<typeof import('jose')>();
  return {
    ...original,
    createRemoteJWKSet: vi.fn(() => {
      // Return function that resolves using our test public key
      return async (_protectedHeader: { kid?: string }) => publicKey;
    }),
  };
});

import { verifyJwt } from '../../src/middleware/auth-jwt.js';

const ISSUER = 'https://authway.test';
const AUD = 'central-rbac-ui@project1';
const AZP = 'central-rbac-admin@project1';

function makeReply() {
  return {
    _status: 0,
    _body: null as unknown,
    jwtClaims: undefined as unknown,
    status(code: number) { this._status = code; return this; },
    send(body: unknown) { this._body = body; return this; },
  };
}

function makeRequest(token?: string, url = '/v1/permissions') {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    url,
    ip: '127.0.0.1',
    id: 'req-test-123',
    jwtClaims: undefined,
  } as Parameters<typeof verifyJwt>[0];
}

async function signToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    azp: AZP,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setExpirationTime('1h')
    .setSubject('user-sub-123')
    .sign(privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  publicKey = kp.publicKey;
});

describe('verifyJwt', () => {
  it('passes with valid token (correct iss, aud, azp, sig)', async () => {
    const token = await signToken();
    const req = makeRequest(token);
    const reply = makeReply();
    await verifyJwt(req, reply as never);
    expect(reply._status).toBe(0); // no rejection
  });

  it('rejects missing Authorization header with 401', async () => {
    const req = makeRequest(undefined);
    const reply = makeReply();
    await verifyJwt(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('rejects token with wrong aud with 401', async () => {
    // Sign with wrong audience
    const token = await new SignJWT({ azp: AZP })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience('wrong-audience')
      .setExpirationTime('1h')
      .setSubject('user-sub-123')
      .sign(privateKey);

    const req = makeRequest(token);
    const reply = makeReply();
    await verifyJwt(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('rejects token with wrong azp with 401', async () => {
    const token = await signToken({ azp: 'wrong-client@project1' });
    const req = makeRequest(token);
    const reply = makeReply();
    await verifyJwt(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('rejects token with wrong issuer with 401', async () => {
    const token = await new SignJWT({ azp: AZP })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setIssuer('https://wrong.issuer')
      .setAudience(AUD)
      .setExpirationTime('1h')
      .setSubject('user-sub-123')
      .sign(privateKey);

    const req = makeRequest(token);
    const reply = makeReply();
    await verifyJwt(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('rejects expired token with 401', async () => {
    const token = await new SignJWT({ azp: AZP })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .setSubject('user-sub-123')
      .sign(privateKey);

    const req = makeRequest(token);
    const reply = makeReply();
    await verifyJwt(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('rejects rbac_degraded token on mutating path with 403', async () => {
    const token = await signToken({ rbac_degraded: true });
    const req = makeRequest(token, '/v1/permissions');
    const reply = makeReply();
    await verifyJwt(req, reply as never);
    expect(reply._status).toBe(403);
  });

  it('allows rbac_degraded token on read-only /v1/audit path', async () => {
    const token = await signToken({ rbac_degraded: true });
    const req = makeRequest(token, '/v1/audit');
    const reply = makeReply();
    await verifyJwt(req, reply as never);
    expect(reply._status).toBe(0);
  });

  it('sets request.jwtClaims on success', async () => {
    const token = await signToken();
    const req = makeRequest(token);
    const reply = makeReply();
    await verifyJwt(req, reply as never);
    expect((req as { jwtClaims?: unknown }).jwtClaims).toBeDefined();
    expect((req as { jwtClaims?: { sub?: string } }).jwtClaims?.sub).toBe('user-sub-123');
  });
});
