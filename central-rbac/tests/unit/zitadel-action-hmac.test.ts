/**
 * zitadel-action-hmac.test.ts — Unit tests for HMAC signature verification.
 * Confirmed algorithm: HMAC-SHA256(key_utf8, unix_ts_string + "." + rawBody)
 * Header format: ZITADEL-Signature: t=<unix_ts>,v1=<hex_sha256>
 */
import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// Mock config before importing the middleware — config.ts calls loadConfig() at
// module evaluation time and throws if required env vars are missing.
vi.mock('../../src/config.js', () => ({
  config: {
    ZITADEL_ACTION_SIGNING_KEY: 'test-signing-key-minimum-16-chars',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { verifyZitadelSignature } = await import('../../src/middleware/zitadel-action-hmac.js');

const TEST_KEY = 'test-signing-key-minimum-16-chars';
const TEST_BODY = Buffer.from('{"user":{"id":"abc123"},"org":{"id":"org1"}}', 'utf8');

/** Build a valid HMAC signature header for testing */
function makeSignatureHeader(
  body: Buffer,
  key: string,
  tsOverride?: number,
): string {
  const ts = tsOverride ?? Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', key);
  mac.update(`${ts}.`);
  mac.update(body);
  const hex = mac.digest('hex');
  return `t=${ts},v1=${hex}`;
}

describe('verifyZitadelSignature', () => {
  it('accepts a valid signature with correct key and current timestamp', () => {
    const header = makeSignatureHeader(TEST_BODY, TEST_KEY);
    const result = verifyZitadelSignature(TEST_BODY, header, TEST_KEY);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('rejects when signing key is empty', () => {
    const header = makeSignatureHeader(TEST_BODY, TEST_KEY);
    const result = verifyZitadelSignature(TEST_BODY, header, '');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signing_key_not_configured');
  });

  it('rejects malformed header (missing v1)', () => {
    const result = verifyZitadelSignature(TEST_BODY, `t=${Math.floor(Date.now() / 1000)}`, TEST_KEY);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('header_parse_failed');
  });

  it('rejects header with non-hex signature', () => {
    const ts = Math.floor(Date.now() / 1000);
    const result = verifyZitadelSignature(TEST_BODY, `t=${ts},v1=not-hex-at-all!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`, TEST_KEY);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('header_parse_failed');
  });

  it('rejects an expired timestamp (older than 5 min)', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 6 * 60; // 6 min ago
    const header = makeSignatureHeader(TEST_BODY, TEST_KEY, oldTs);
    const result = verifyZitadelSignature(TEST_BODY, header, TEST_KEY);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp_expired');
  });

  it('rejects a future timestamp beyond 60s skew', () => {
    const futureTs = Math.floor(Date.now() / 1000) + 120; // 2 min ahead
    const header = makeSignatureHeader(TEST_BODY, TEST_KEY, futureTs);
    const result = verifyZitadelSignature(TEST_BODY, header, TEST_KEY);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp_future');
  });

  it('accepts a timestamp within the 60s future skew window', () => {
    const nearFutureTs = Math.floor(Date.now() / 1000) + 30; // 30s ahead — within 60s skew
    const header = makeSignatureHeader(TEST_BODY, TEST_KEY, nearFutureTs);
    const result = verifyZitadelSignature(TEST_BODY, header, TEST_KEY);
    expect(result.valid).toBe(true);
  });

  it('rejects a signature computed with wrong key', () => {
    const header = makeSignatureHeader(TEST_BODY, 'wrong-key-entirely-different-value');
    const result = verifyZitadelSignature(TEST_BODY, header, TEST_KEY);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('sig_mismatch');
  });

  it('rejects when raw body bytes differ from signed body', () => {
    const header = makeSignatureHeader(TEST_BODY, TEST_KEY);
    const tamperedBody = Buffer.from('{"user":{"id":"TAMPERED"},"org":{"id":"org1"}}', 'utf8');
    const result = verifyZitadelSignature(tamperedBody, header, TEST_KEY);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('sig_mismatch');
  });

  it('rejects a non-numeric timestamp', () => {
    const result = verifyZitadelSignature(TEST_BODY, 't=notanumber,v1=' + 'a'.repeat(64), TEST_KEY);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp_not_a_number');
  });

  it('verifies correctly with UTF-8 multi-byte body content', () => {
    const unicodeBody = Buffer.from('{"name":"Nguyễn Văn A","org":"公司"}', 'utf8');
    const header = makeSignatureHeader(unicodeBody, TEST_KEY);
    const result = verifyZitadelSignature(unicodeBody, header, TEST_KEY);
    expect(result.valid).toBe(true);
  });
});
