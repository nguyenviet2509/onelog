/**
 * run-conformance.test.ts — 20 scenarios from ../scenarios.md.
 *
 * Groups: A (auth 4), B (cache 5), C (circuit breaker 4), D (security 4), E (behavior 3).
 * SDK: @onelog/central-rbac-client (file: link).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { CentralRbacClient, CentralRbacError } from '@onelog/central-rbac-client';
import type { SdkLogger } from '@onelog/central-rbac-client';
import { startMockCentral, type MockControls } from './mock-central-server';

const VALID_TOKEN = 'rbac_ab12cd34_efgh5678ijkl9012mnop3456';
const LEGACY_TOKEN = 'abcdef1234567890';
const APP_SLUG = 'test-app';

interface CapturedLog { level: string; obj: unknown; msg?: string }

function makeSpyLogger(): { logger: SdkLogger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const logger: SdkLogger = {
    debug: (obj, msg) => logs.push({ level: 'debug', obj, msg }),
    info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
  };
  return { logger, logs };
}

function makeClient(mock: MockControls, overrides: Record<string, unknown> = {}) {
  return new CentralRbacClient({
    centralUrl: mock.baseUrl,
    appSlug: APP_SLUG,
    centralRbacToken: VALID_TOKEN,
    epochPollIntervalSec: 3600,       // effectively off unless overridden
    requestTimeoutMs: 500,
    ...overrides,
  });
}

let mock: MockControls;
const openClients: CentralRbacClient[] = [];

beforeAll(async () => {
  mock = await startMockCentral();
});

afterAll(async () => {
  for (const c of openClients) {
    try { c.close(); } catch { /* ignore */ }
  }
  await mock.stop();
});

beforeEach(() => {
  // Close all lingering pollers from previous tests so poll counters isolate.
  while (openClients.length > 0) {
    const c = openClients.pop();
    try { c?.close(); } catch { /* ignore */ }
  }
  mock.reset();
  delete process.env['NODE_ENV'];
});

function track(c: CentralRbacClient): CentralRbacClient {
  openClients.push(c);
  return c;
}

// ═══════════════════════════════════════════════════════════════════
// Group A — Authentication (4)
// ═══════════════════════════════════════════════════════════════════

describe('Group A — Authentication', () => {
  it('A1: per-app token format → forwarded in X-Rbac-Token header, no warn', async () => {
    const { logger, logs } = makeSpyLogger();
    const client = track(makeClient(mock, { logger }));
    await client.resolve('user-1');
    expect(mock.counters.lastAuthHeader).toBe(VALID_TOKEN);
    const legacyWarns = logs.filter((l) => l.level === 'warn' && String(l.msg ?? '').includes('legacy'));
    expect(legacyWarns.length).toBe(0);
  });

  it('A2: Central 401 → RBAC_INVALID_TOKEN', async () => {
    mock.setMode('unauthorized');
    const client = track(makeClient(mock));
    await expect(client.resolve('user-1')).rejects.toMatchObject({
      code: 'RBAC_INVALID_TOKEN',
      httpStatus: 401,
    });
  });

  it('A3: missing token in config → RBAC_SDK_CONFIG_ERROR at construct', () => {
    expect(() => new CentralRbacClient({
      centralUrl: mock.baseUrl,
      appSlug: APP_SLUG,
      centralRbacToken: '',
    })).toThrow(expect.objectContaining({
      code: 'RBAC_SDK_CONFIG_ERROR',
    }) as unknown as Error);
  });

  it('A4: legacy token → warn once, does not throw', () => {
    const { logger, logs } = makeSpyLogger();
    const client = track(makeClient(mock, { logger, centralRbacToken: LEGACY_TOKEN }));
    expect(client).toBeDefined();
    const legacyWarns = logs.filter((l) =>
      l.level === 'warn' && (String(l.msg ?? '').includes('per-app') || JSON.stringify(l).includes('per-app'))
    );
    expect(legacyWarns.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group B — Cache (5)
// ═══════════════════════════════════════════════════════════════════

describe('Group B — Cache', () => {
  it('B1: first request → cache miss → Central called → response cached:false', async () => {
    const client = track(makeClient(mock));
    const res = await client.resolve('user-1');
    expect(mock.counters.resolveCalls).toBe(1);
    expect(res.cached).toBe(false);
  });

  it('B2: second request within TTL → hit cache → no extra Central call', async () => {
    const client = track(makeClient(mock));
    await client.resolve('user-1');
    const res = await client.resolve('user-1');
    expect(mock.counters.resolveCalls).toBe(1);
    expect(res.cached).toBe(true);
  });

  it('B3: different tenant_id → separate cache entry, new Central call', async () => {
    const client = track(makeClient(mock));
    await client.resolve('user-1', 'dept-a');
    await client.resolve('user-1', 'dept-b');
    expect(mock.counters.resolveCalls).toBe(2);
  });

  it('B4: epoch bump → poller flush → cache miss on next resolve', async () => {
    const client = track(makeClient(mock, { epochPollIntervalSec: 0.05 }));
    // Wait for poller to establish baseline epoch=1 first
    await new Promise((r) => setTimeout(r, 100));
    expect(mock.counters.epochCalls).toBeGreaterThanOrEqual(1);
    await client.resolve('user-1');
    expect(mock.counters.resolveCalls).toBe(1);
    // Bump AFTER baseline established → poller will detect change on next tick
    mock.setEpoch(2);
    await new Promise((r) => setTimeout(r, 200));
    await client.resolve('user-1');
    expect(mock.counters.resolveCalls).toBe(2);
  });

  it('B5: manual flushCache() → next resolve → cache miss', async () => {
    const client = track(makeClient(mock));
    await client.resolve('user-1');
    client.flushCache();
    await client.resolve('user-1');
    expect(mock.counters.resolveCalls).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group C — Circuit breaker (4)
// ═══════════════════════════════════════════════════════════════════

describe('Group C — Circuit breaker', () => {
  it('C1: 5 consecutive 500 errors → 6th call throws RBAC_CIRCUIT_OPEN without HTTP', async () => {
    mock.setMode('server_error');
    const client = track(makeClient(mock, { circuitBreakerThreshold: 5, circuitBreakerResetSec: 3600 }));
    for (let i = 0; i < 5; i++) {
      await expect(client.resolve(`user-${i}`)).rejects.toBeInstanceOf(CentralRbacError);
    }
    expect(mock.counters.resolveCalls).toBe(5);
    await expect(client.resolve('user-6')).rejects.toMatchObject({ code: 'RBAC_CIRCUIT_OPEN' });
    expect(mock.counters.resolveCalls).toBe(5);
  });

  it('C2: circuit open → subsequent calls throw without HTTP call', async () => {
    mock.setMode('server_error');
    const client = track(makeClient(mock, { circuitBreakerThreshold: 5, circuitBreakerResetSec: 3600 }));
    for (let i = 0; i < 5; i++) {
      await expect(client.resolve(`user-${i}`)).rejects.toBeInstanceOf(CentralRbacError);
    }
    const before = mock.counters.resolveCalls;
    await expect(client.resolve('u-next-a')).rejects.toMatchObject({ code: 'RBAC_CIRCUIT_OPEN' });
    await expect(client.resolve('u-next-b')).rejects.toMatchObject({ code: 'RBAC_CIRCUIT_OPEN' });
    expect(mock.counters.resolveCalls).toBe(before);
  });

  it('C3: after reset timeout → half-open → 1 probe allowed', async () => {
    mock.setMode('server_error');
    const client = track(makeClient(mock, { circuitBreakerThreshold: 5, circuitBreakerResetSec: 0.2 }));
    for (let i = 0; i < 5; i++) {
      await expect(client.resolve(`u-${i}`)).rejects.toBeInstanceOf(CentralRbacError);
    }
    await new Promise((r) => setTimeout(r, 250));
    const before = mock.counters.resolveCalls;
    await expect(client.resolve('probe')).rejects.toBeInstanceOf(CentralRbacError);
    expect(mock.counters.resolveCalls).toBe(before + 1);
  });

  it('C4: probe success → circuit closed → normal operation resumes', async () => {
    mock.setMode('server_error');
    const client = track(makeClient(mock, { circuitBreakerThreshold: 5, circuitBreakerResetSec: 0.2 }));
    for (let i = 0; i < 5; i++) {
      await expect(client.resolve(`u-${i}`)).rejects.toBeInstanceOf(CentralRbacError);
    }
    await new Promise((r) => setTimeout(r, 250));
    mock.setMode('ok');
    // First call after reset = probe (success → close)
    await client.resolve('probe');
    // Now normal
    for (let i = 0; i < 3; i++) {
      const res = await client.resolve(`follow-${i}`);
      expect(res).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group D — Security (4)
// ═══════════════════════════════════════════════════════════════════

describe('Group D — Security', () => {
  it('D1: NODE_ENV=production + failMode=open → constructor throws RBAC_SDK_CONFIG_ERROR', () => {
    process.env['NODE_ENV'] = 'production';
    expect(() => new CentralRbacClient({
      centralUrl: mock.baseUrl,
      appSlug: APP_SLUG,
      centralRbacToken: VALID_TOKEN,
      failMode: 'open',
    })).toThrow(expect.objectContaining({
      code: 'RBAC_SDK_CONFIG_ERROR',
    }) as unknown as Error);
  });

  it('D2: Central 5xx + failMode=closed → throws RBAC_CENTRAL_5XX, does NOT return empty perms', async () => {
    mock.setMode('server_error');
    const client = track(makeClient(mock, { failMode: 'closed' }));
    await expect(client.resolve('user-1')).rejects.toMatchObject({ code: 'RBAC_CENTRAL_5XX' });
  });

  it('D3: no full token in any log output', async () => {
    const { logger, logs } = makeSpyLogger();
    // Trigger multiple log paths: legacy warn, error path, cache hit debug
    const client = track(makeClient(mock, { logger, centralRbacToken: LEGACY_TOKEN }));
    await client.resolve('user-1');
    mock.setMode('unauthorized');
    await expect(client.resolve('user-2')).rejects.toBeInstanceOf(CentralRbacError);

    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(LEGACY_TOKEN);
    expect(dump).not.toContain(VALID_TOKEN);
  });

  it('D4: X-Api-Version mismatch → RBAC_MANIFEST_MISMATCH, cache not populated', async () => {
    mock.setApiVersion('1');
    const client = track(makeClient(mock));
    await expect(client.resolve('user-1')).rejects.toMatchObject({ code: 'RBAC_MANIFEST_MISMATCH' });
    // Follow-up call must retry (not served from cache)
    mock.setApiVersion('2');
    await client.resolve('user-1');
    expect(mock.counters.resolveCalls).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group E — Behavior (3)
// ═══════════════════════════════════════════════════════════════════

describe('Group E — Behavior', () => {
  it('E1: epoch poller runs every epochPollIntervalSec', async () => {
    const client = track(makeClient(mock, { epochPollIntervalSec: 0.1 }));
    await new Promise((r) => setTimeout(r, 400));
    expect(mock.counters.epochCalls).toBeGreaterThanOrEqual(3);
    // Reference so client stays alive
    void client;
  });

  it('E2: resolve() returns full ResolveResponse shape (7 keys)', async () => {
    const client = track(makeClient(mock));
    const res = await client.resolve('user-1', 'dept-a');
    expect(res).toEqual(expect.objectContaining({
      user_sub: expect.any(String),
      app_slug: expect.any(String),
      tenant_id: expect.anything(),                // string | null
      effective_roles: expect.any(Array),
      permissions: expect.any(Array),
      epoch: expect.any(Number),
      cached: expect.any(Boolean),
    }));
  });

  it('E3: close() stops poller (no more epoch calls after close)', async () => {
    const client = makeClient(mock, { epochPollIntervalSec: 0.05 });
    await new Promise((r) => setTimeout(r, 150));
    const before = mock.counters.epochCalls;
    client.close();
    await new Promise((r) => setTimeout(r, 300));
    const after = mock.counters.epochCalls;
    // Allow at most 1 in-flight tick to complete, then poller must stop
    expect(after - before).toBeLessThanOrEqual(1);
  });
});
