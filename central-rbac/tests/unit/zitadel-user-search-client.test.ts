/**
 * zitadel-user-search-client.test.ts — Unit tests for user search + detail client.
 *
 * Coverage target: ≥80% lines/functions/branches for src/lib/zitadel-user-search-client.ts
 * Strategy: vi.mock mgmtPost + global fetch; no real network calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    ZITADEL_MGMT_URL: 'http://zitadel-mock:8080',
    ZITADEL_SA_PAT: 'test-pat-token',
    ZITADEL_ORG_ID: 'org-test-456',
    ZITADEL_EXTERNAL_HOST: '',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock mgmtPost from zitadel-http — searchUsers calls this
vi.mock('../../src/lib/zitadel-http.js', () => ({
  mgmtPost: vi.fn(),
  buildHeaders: vi.fn(() => ({
    'Content-Type': 'application/json',
    Authorization: 'Bearer test-pat-token',
    'x-zitadel-orgid': 'org-test-456',
  })),
}));

import { mgmtPost } from '../../src/lib/zitadel-http.js';
const mockMgmtPost = vi.mocked(mgmtPost);

const { searchUsers, getUserById } = await import('../../src/lib/zitadel-user-search-client.js');

const ORG_ID = 'org-test-456';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeError(status: number): Response {
  return new Response(JSON.stringify({ message: 'zitadel internal error detail' }), { status });
}

const RAW_HUMAN_USER = {
  userId: 'u-001',
  username: 'jdoe',
  human: {
    profile: { displayName: 'John Doe', firstName: 'John', lastName: 'Doe' },
    email: { email: 'john@example.com' },
  },
  preferredLoginName: 'jdoe@example.com',
  state: 'USER_STATE_ACTIVE',
};

const RAW_MACHINE_USER = {
  userId: 'u-svc',
  machine: { name: 'service-account' },
  loginNames: ['service@example.com'],
  state: 'USER_STATE_ACTIVE',
};

// ── searchUsers ───────────────────────────────────────────────────────────────

describe('searchUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns users + total on 200 with empty q', async () => {
    mockMgmtPost.mockResolvedValue(makeOk({
      result: [RAW_HUMAN_USER],
      details: { totalResult: '1' },
    }));

    const { users, total } = await searchUsers('', 50, 0, ORG_ID);

    expect(users).toHaveLength(1);
    expect(users[0].id).toBe('u-001');
    expect(users[0].email).toBe('john@example.com');
    expect(users[0].display_name).toBe('John Doe');
    expect(total).toBe(1);
    // No queries filter sent for empty q
    const body = mockMgmtPost.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body['queries']).toBeUndefined();
  });

  it('sends orQuery filter when q is non-empty', async () => {
    mockMgmtPost.mockResolvedValue(makeOk({ result: [], details: { totalResult: '0' } }));

    await searchUsers('alice', 20, 10, ORG_ID);

    const body = mockMgmtPost.mock.calls[0]?.[2] as Record<string, unknown>;
    const queries = body['queries'] as unknown[];
    expect(queries).toHaveLength(1);
    const orQuery = (queries[0] as { orQuery: { queries: unknown[] } }).orQuery;
    expect(orQuery.queries).toHaveLength(2); // userName + email
  });

  it('passes limit and offset in query', async () => {
    mockMgmtPost.mockResolvedValue(makeOk({ result: [] }));

    await searchUsers('', 25, 50, ORG_ID);

    const body = mockMgmtPost.mock.calls[0]?.[2] as Record<string, unknown>;
    const q = body['query'] as { limit: number; offset: string };
    expect(q.limit).toBe(25);
    expect(q.offset).toBe('50');
  });

  it('derives total from result length when details.totalResult absent', async () => {
    mockMgmtPost.mockResolvedValue(makeOk({ result: [RAW_HUMAN_USER, RAW_MACHINE_USER] }));

    const { total } = await searchUsers('', 50, 0, ORG_ID);
    expect(total).toBe(2);
  });

  it('returns empty users + 0 total when result is absent', async () => {
    mockMgmtPost.mockResolvedValue(makeOk({}));

    const { users, total } = await searchUsers('', 50, 0, ORG_ID);
    expect(users).toEqual([]);
    expect(total).toBe(0);
  });

  it('throws on 401 — does not leak Zitadel body to caller', async () => {
    mockMgmtPost.mockResolvedValue(makeError(401));

    await expect(searchUsers('', 50, 0, ORG_ID)).rejects.toThrow('HTTP 401');
    // Ensure the internal zitadel error text is NOT in the thrown message
    const err = await searchUsers('', 50, 0, ORG_ID).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('zitadel internal error detail');
  });

  it('throws on 500 — error message is generic', async () => {
    mockMgmtPost.mockResolvedValue(makeError(500));
    await expect(searchUsers('', 50, 0, ORG_ID)).rejects.toThrow('HTTP 500');
  });

  it('wraps network error with readable message', async () => {
    mockMgmtPost.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(searchUsers('', 50, 0, ORG_ID)).rejects.toThrow('Zitadel user search unreachable');
  });

  it('normalizes machine user — display_name falls back to machine.name', async () => {
    mockMgmtPost.mockResolvedValue(makeOk({ result: [RAW_MACHINE_USER] }));

    const { users } = await searchUsers('', 50, 0, ORG_ID);
    expect(users[0].display_name).toBe('service-account');
    expect(users[0].email).toBe('service@example.com'); // from loginNames[0]
  });
});

// ── getUserById ───────────────────────────────────────────────────────────────

describe('getUserById', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns normalized user on 200', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOk({ user: RAW_HUMAN_USER }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await getUserById('u-001', ORG_ID);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('u-001');
    expect(result?.email).toBe('john@example.com');
    expect(result?.display_name).toBe('John Doe');
  });

  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeError(404)));
    const result = await getUserById('u-missing', ORG_ID);
    expect(result).toBeNull();
  });

  it('returns null when user field absent in 200 body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOk({})));
    const result = await getUserById('u-001', ORG_ID);
    expect(result).toBeNull();
  });

  it('throws on 403 non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeError(403)));
    await expect(getUserById('u-001', ORG_ID)).rejects.toThrow('HTTP 403');
  });

  it('wraps network error with readable message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));
    await expect(getUserById('u-001', ORG_ID)).rejects.toThrow('Zitadel get user unreachable');
  });

  it('URL-encodes userId in path', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeError(404));
    vi.stubGlobal('fetch', mockFetch);

    await getUserById('user/with/slashes', ORG_ID);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('user%2Fwith%2Fslashes');
  });
});

// ── normalizeUser (via searchUsers) ──────────────────────────────────────────

describe('normalizeUser display_name fallback chain', () => {
  beforeEach(() => vi.clearAllMocks());

  async function normalize(raw: Record<string, unknown>) {
    mockMgmtPost.mockResolvedValue(makeOk({ result: [raw] }));
    const { users } = await searchUsers('', 50, 0, ORG_ID);
    return users[0];
  }

  it('prefers displayName', async () => {
    const u = await normalize({
      userId: 'x',
      human: { profile: { displayName: 'Display', firstName: 'First', lastName: 'Last' }, email: { email: 'e@x.com' } },
    });
    expect(u.display_name).toBe('Display');
  });

  it('falls back to firstName + lastName when no displayName', async () => {
    const u = await normalize({
      userId: 'x',
      human: { profile: { firstName: 'Alice', lastName: 'Smith' }, email: { email: 'a@x.com' } },
    });
    expect(u.display_name).toBe('Alice Smith');
  });

  it('falls back to machine.name when no human profile', async () => {
    const u = await normalize({ userId: 'x', machine: { name: 'bot' }, loginNames: ['bot@x.com'] });
    expect(u.display_name).toBe('bot');
  });

  it('falls back to username when no machine.name', async () => {
    const u = await normalize({ userId: 'x', username: 'myuser', preferredLoginName: 'myuser@x.com' });
    expect(u.display_name).toBe('myuser');
  });

  it('falls back to email (preferredLoginName) as last resort', async () => {
    const u = await normalize({ userId: 'x', preferredLoginName: 'last@x.com' });
    expect(u.display_name).toBe('last@x.com');
  });

  it('handles fully empty raw user without throwing', async () => {
    const u = await normalize({ userId: 'x' });
    expect(u.id).toBe('x');
    expect(u.email).toBe('');
    expect(u.display_name).toBe('');
  });
});
