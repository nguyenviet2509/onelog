/**
 * client-config.test.ts — Unit tests cho CentralRbacClient constructor validation.
 * Ưu tiên hardcoded production+failMode=open reject (no loophole).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { CentralRbacClient } from '../src/client.js';
import { CentralRbacError } from '../src/errors.js';
import { extractTenantId } from '../src/util/extract-tenant-id.js';

const validConfig = {
  centralUrl: 'https://central.local',
  appSlug: 'testapp',
  centralRbacToken: 'test-token-abc',
};

let clients: CentralRbacClient[] = [];

afterEach(() => {
  clients.forEach((c) => c.close());
  clients = [];
  delete process.env['NODE_ENV'];
});

function build(cfg: ConstructorParameters<typeof CentralRbacClient>[0]): CentralRbacClient {
  const c = new CentralRbacClient(cfg);
  clients.push(c);
  return c;
}

describe('CentralRbacClient — config validation', () => {
  it('accepts valid config', () => {
    expect(() => build(validConfig)).not.toThrow();
  });

  it('rejects missing centralUrl', () => {
    expect(() => build({ ...validConfig, centralUrl: '' })).toThrow(CentralRbacError);
  });

  it('rejects missing appSlug', () => {
    expect(() => build({ ...validConfig, appSlug: '' })).toThrow(CentralRbacError);
  });

  it('rejects missing centralRbacToken', () => {
    expect(() => build({ ...validConfig, centralRbacToken: '' })).toThrow(CentralRbacError);
  });

  it('HARDCODED reject: NODE_ENV=production + failMode=open throws startup error', () => {
    process.env['NODE_ENV'] = 'production';
    expect(() => build({ ...validConfig, failMode: 'open' })).toThrow(/failMode=open is DEV ONLY/);
  });

  it('allows failMode=open trong dev', () => {
    process.env['NODE_ENV'] = 'development';
    expect(() => build({ ...validConfig, failMode: 'open' })).not.toThrow();
  });

  it('allows failMode=closed trong production', () => {
    process.env['NODE_ENV'] = 'production';
    expect(() => build({ ...validConfig, failMode: 'closed' })).not.toThrow();
  });

  it('default failMode = closed', () => {
    process.env['NODE_ENV'] = 'production';
    expect(() => build(validConfig)).not.toThrow(); // no failMode = closed = safe
  });
});

describe('extractTenantId', () => {
  it('extracts from query', () => {
    expect(extractTenantId({ query: { dept: 'cntt' } }, 'query.dept')).toBe('cntt');
  });

  it('extracts from params', () => {
    expect(extractTenantId({ params: { org: 'inet' } }, 'params.org')).toBe('inet');
  });

  it('extracts from headers', () => {
    expect(extractTenantId({ headers: { 'x-tid': 'dept-a' } }, 'headers.x-tid')).toBe('dept-a');
  });

  it('extracts from body', () => {
    expect(extractTenantId({ body: { dept: 'kt' } }, 'body.dept')).toBe('kt');
  });

  it('returns null cho missing key', () => {
    expect(extractTenantId({ query: {} }, 'query.dept')).toBe(null);
  });

  it('returns null cho non-string value (chống injection)', () => {
    expect(extractTenantId({ query: { dept: { evil: 'obj' } } }, 'query.dept')).toBe(null);
    expect(extractTenantId({ query: { dept: 123 } }, 'query.dept')).toBe(null);
  });

  it('returns null cho empty string', () => {
    expect(extractTenantId({ query: { dept: '' } }, 'query.dept')).toBe(null);
  });

  it('returns null cho malformed spec (no dot)', () => {
    expect(extractTenantId({ query: { dept: 'x' } }, 'querydept')).toBe(null);
  });
});
