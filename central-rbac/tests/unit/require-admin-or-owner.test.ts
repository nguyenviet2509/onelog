/**
 * require-admin-or-owner.test.ts — Unit tests for ownership-based authz middleware.
 * Covers: requireMember, requireAdminOrAppOwner, requireAdminOrRoleOwner,
 * requireAdminOrPermOwner, listOwnedAppsWhere, isAdmin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config — break-glass sub configured
vi.mock('../../src/config.js', () => ({
  config: {
    NODE_ENV: 'test',
    BREAK_GLASS_USER_ID: 'bg-sub-999',
    BREAK_GLASS_PERMS: 'rbac.admin.write',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock writerPool.query
const mockQuery = vi.fn();
vi.mock('../../src/db/writer-pool.js', () => ({
  writerPool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

const {
  isAdmin,
  isBreakGlass,
  requireMember,
  requireAdminOrAppOwner,
  requireAdminOrRoleOwner,
  requireAdminOrPermOwner,
  listOwnedAppsWhere,
} = await import('../../src/middleware/require-admin-or-owner.js');

// ── Helpers ──────────────────────────────────────────────────────────────

interface MockReply {
  status: (code: number) => MockReply;
  send: (body: unknown) => MockReply;
  _status?: number;
  _body?: unknown;
}

function makeReply(): MockReply {
  const reply: MockReply = {
    status(code) {
      this._status = code;
      return this;
    },
    send(body) {
      this._body = body;
      return this;
    },
  };
  return reply;
}

function makeRequest(overrides: {
  sub?: string;
  roles?: string[];
  params?: Record<string, string>;
  url?: string;
} = {}) {
  return {
    jwtClaims: overrides.sub ? { sub: overrides.sub, roles: overrides.roles ?? [] } : undefined,
    params: overrides.params ?? {},
    url: overrides.url ?? '/test',
  } as never;
}

beforeEach(() => {
  mockQuery.mockReset();
});

// ── isAdmin ──────────────────────────────────────────────────────────────

describe('isAdmin', () => {
  it('returns true for rbac.admin role', () => {
    const req = makeRequest({ sub: 'u1', roles: ['rbac.admin'] });
    expect(isAdmin(req)).toBe(true);
  });

  it('returns true for system.root role', () => {
    const req = makeRequest({ sub: 'u1', roles: ['system.root'] });
    expect(isAdmin(req)).toBe(true);
  });

  it('returns false for rbac.member only', () => {
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'] });
    expect(isAdmin(req)).toBe(false);
  });

  it('returns false when roles empty', () => {
    const req = makeRequest({ sub: 'u1', roles: [] });
    expect(isAdmin(req)).toBe(false);
  });

  it('returns false when no jwtClaims', () => {
    const req = makeRequest({});
    expect(isAdmin(req)).toBe(false);
  });
});

// ── isBreakGlass ─────────────────────────────────────────────────────────

describe('isBreakGlass', () => {
  it('returns true when sub matches BREAK_GLASS_USER_ID', () => {
    const req = makeRequest({ sub: 'bg-sub-999' });
    expect(isBreakGlass(req)).toBe(true);
  });

  it('returns false when sub does not match', () => {
    const req = makeRequest({ sub: 'other-sub' });
    expect(isBreakGlass(req)).toBe(false);
  });

  it('returns false when no jwtClaims', () => {
    const req = makeRequest({});
    expect(isBreakGlass(req)).toBe(false);
  });
});

// ── requireMember ────────────────────────────────────────────────────────

describe('requireMember', () => {
  it('401 when not authenticated', async () => {
    const req = makeRequest({});
    const reply = makeReply();
    await requireMember(req, reply as never);
    expect(reply._status).toBe(401);
  });

  it('passes for break-glass user', async () => {
    const req = makeRequest({ sub: 'bg-sub-999', roles: [] });
    const reply = makeReply();
    await requireMember(req, reply as never);
    expect(reply._status).toBeUndefined();
  });

  it('passes for rbac.admin', async () => {
    const req = makeRequest({ sub: 'u1', roles: ['rbac.admin'] });
    const reply = makeReply();
    await requireMember(req, reply as never);
    expect(reply._status).toBeUndefined();
  });

  it('passes for system.root', async () => {
    const req = makeRequest({ sub: 'u1', roles: ['system.root'] });
    const reply = makeReply();
    await requireMember(req, reply as never);
    expect(reply._status).toBeUndefined();
  });

  it('passes for rbac.member', async () => {
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'] });
    const reply = makeReply();
    await requireMember(req, reply as never);
    expect(reply._status).toBeUndefined();
  });

  it('403 for unrelated role (qlts.admin)', async () => {
    const req = makeRequest({ sub: 'u1', roles: ['qlts.admin'] });
    const reply = makeReply();
    await requireMember(req, reply as never);
    expect(reply._status).toBe(403);
  });

  it('403 when roles empty', async () => {
    const req = makeRequest({ sub: 'u1', roles: [] });
    const reply = makeReply();
    await requireMember(req, reply as never);
    expect(reply._status).toBe(403);
  });
});

// ── requireAdminOrAppOwner ───────────────────────────────────────────────

describe('requireAdminOrAppOwner', () => {
  it('passes for admin without DB query', async () => {
    const req = makeRequest({ sub: 'u1', roles: ['rbac.admin'], params: { slug: 'foo' } });
    const reply = makeReply();
    await requireAdminOrAppOwner('slug')(req, reply as never);
    expect(reply._status).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('passes for owner (created_by matches sub)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'u1' }] });
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'], params: { slug: 'foo' } });
    const reply = makeReply();
    await requireAdminOrAppOwner('slug')(req, reply as never);
    expect(reply._status).toBeUndefined();
  });

  it('403 for non-owner member', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'other-sub' }] });
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'], params: { slug: 'foo' } });
    const reply = makeReply();
    await requireAdminOrAppOwner('slug')(req, reply as never);
    expect(reply._status).toBe(403);
  });

  it('404 when app not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'], params: { slug: 'missing' } });
    const reply = makeReply();
    await requireAdminOrAppOwner('slug')(req, reply as never);
    expect(reply._status).toBe(404);
  });

  it('400 when param missing', async () => {
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'], params: {} });
    const reply = makeReply();
    await requireAdminOrAppOwner('slug')(req, reply as never);
    expect(reply._status).toBe(400);
  });

  it('supports id paramName', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'u1' }] });
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'], params: { id: 'app-uuid' } });
    const reply = makeReply();
    await requireAdminOrAppOwner('id')(req, reply as never);
    expect(reply._status).toBeUndefined();
    expect(mockQuery.mock.calls[0]![0]).toContain('WHERE id = $1');
  });
});

// ── requireAdminOrRoleOwner ──────────────────────────────────────────────

describe('requireAdminOrRoleOwner', () => {
  it('passes for admin', async () => {
    const req = makeRequest({ sub: 'u1', roles: ['rbac.admin'], params: { key: 'foo.admin' } });
    const reply = makeReply();
    await requireAdminOrRoleOwner('key')(req, reply as never);
    expect(reply._status).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('403 for legacy role (app_id NULL)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: null, app_id: null }] });
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'], params: { key: 'system.root' } });
    const reply = makeReply();
    await requireAdminOrRoleOwner('key')(req, reply as never);
    expect(reply._status).toBe(403);
    expect(reply._body).toEqual({ error: 'Forbidden — legacy role, admin only' });
  });

  it('passes for role owner', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ created_by: 'u1', app_id: 'app-uuid' }],
    });
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'], params: { key: 'foo.admin' } });
    const reply = makeReply();
    await requireAdminOrRoleOwner('key')(req, reply as never);
    expect(reply._status).toBeUndefined();
  });

  it('403 for non-owner', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ created_by: 'other-sub', app_id: 'app-uuid' }],
    });
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'], params: { key: 'foo.admin' } });
    const reply = makeReply();
    await requireAdminOrRoleOwner('key')(req, reply as never);
    expect(reply._status).toBe(403);
  });

  it('404 when role not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'], params: { key: 'missing.role' } });
    const reply = makeReply();
    await requireAdminOrRoleOwner('key')(req, reply as never);
    expect(reply._status).toBe(404);
  });
});

// ── requireAdminOrPermOwner ──────────────────────────────────────────────

describe('requireAdminOrPermOwner', () => {
  it('passes for admin', async () => {
    const req = makeRequest({ sub: 'u1', roles: ['rbac.admin'], params: { key: 'foo.bar' } });
    const reply = makeReply();
    await requireAdminOrPermOwner('key')(req, reply as never);
    expect(reply._status).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('passes for owner (prefix matches owned app)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'u1' }] });
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'], params: { key: 'foo.bar' } });
    const reply = makeReply();
    await requireAdminOrPermOwner('key')(req, reply as never);
    expect(reply._status).toBeUndefined();
    expect(mockQuery.mock.calls[0]![1]).toEqual(['foo']);
  });

  it('403 for non-owner prefix', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'other-sub' }] });
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'], params: { key: 'foo.bar' } });
    const reply = makeReply();
    await requireAdminOrPermOwner('key')(req, reply as never);
    expect(reply._status).toBe(403);
  });

  it('403 for prefix not matching any app (system.*)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'], params: { key: 'system.evil' } });
    const reply = makeReply();
    await requireAdminOrPermOwner('key')(req, reply as never);
    expect(reply._status).toBe(403);
  });
});

// ── listOwnedAppsWhere ───────────────────────────────────────────────────

describe('listOwnedAppsWhere', () => {
  it('returns TRUE for admin', () => {
    const req = makeRequest({ sub: 'u1', roles: ['rbac.admin'] });
    expect(listOwnedAppsWhere(req)).toEqual({ where: 'TRUE', params: [] });
  });

  it('returns TRUE for break-glass', () => {
    const req = makeRequest({ sub: 'bg-sub-999', roles: [] });
    expect(listOwnedAppsWhere(req)).toEqual({ where: 'TRUE', params: [] });
  });

  it('returns filter for member', () => {
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'] });
    expect(listOwnedAppsWhere(req)).toEqual({
      where: 'created_by = $1',
      params: ['u1'],
    });
  });

  it('respects paramOffset', () => {
    const req = makeRequest({ sub: 'u1', roles: ['rbac.member'] });
    expect(listOwnedAppsWhere(req, 2)).toEqual({
      where: 'created_by = $3',
      params: ['u1'],
    });
  });

  it('returns FALSE fail-close when no sub', () => {
    const req = makeRequest({});
    expect(listOwnedAppsWhere(req)).toEqual({ where: 'FALSE', params: [] });
  });
});
