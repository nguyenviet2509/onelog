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

describe('CentralRbacClient — legacy token warn (0.2.0)', () => {
  it('warns when token does not match per-app format', () => {
    const warnCalls: unknown[][] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (obj: unknown, msg?: string) => warnCalls.push([obj, msg]),
      error: () => undefined,
    };
    build({ ...validConfig, centralRbacToken: 'legacy-shared-token', logger });
    expect(warnCalls.length).toBe(1);
    expect(String(warnCalls[0][1])).toContain('per-app format');
  });

  it('does not warn when token matches per-app format', () => {
    const warnCalls: unknown[][] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (obj: unknown, msg?: string) => warnCalls.push([obj, msg]),
      error: () => undefined,
    };
    build({
      ...validConfig,
      centralRbacToken: 'rbac_abc12345_kqr7x8v9w2n5c4b1d6h3p0aa',
      logger,
    });
    expect(warnCalls.length).toBe(0);
  });
});
