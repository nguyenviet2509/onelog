/**
 * zitadel-mgmt-client-phase3.test.ts — Unit tests for Phase 3 Mgmt API methods.
 * Covers: addProjectRole, removeProjectRole, addUserGrant, updateUserGrant,
 *         removeUserGrant, listProjectRoles.
 * S1 gate idempotency behaviors: 409→success, 404→success, 200-idempotent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    ZITADEL_MGMT_URL: 'http://zitadel-mock:8080',
    ZITADEL_SA_PAT: 'test-pat',
    ZITADEL_EXTERNAL_HOST: '',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  addProjectRole,
  removeProjectRole,
  addUserGrant,
  updateUserGrant,
  removeUserGrant,
  listProjectRoles,
} from '../../src/lib/zitadel-mgmt-client.js';

function ok(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(status: number, message = 'error'): Response {
  return new Response(JSON.stringify({ code: status, message }), { status });
}

const ORG_ID = 'org-test';
const PROJECT_ID = 'proj-test';

describe('addProjectRole', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns created=true on 200', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ details: {} }));
    const result = await addProjectRole(PROJECT_ID, ORG_ID, 'role.x', 'Role X');
    expect(result.created).toBe(true);
  });

  it('returns created=false on 409 (idempotency — S1 gate)', async () => {
    vi.mocked(fetch).mockResolvedValue(err(409, 'Role already exists'));
    const result = await addProjectRole(PROJECT_ID, ORG_ID, 'role.x', 'Role X');
    expect(result.created).toBe(false); // 409 treated as success
  });

  it('throws on 403 Forbidden', async () => {
    vi.mocked(fetch).mockResolvedValue(err(403, 'Permission denied'));
    await expect(addProjectRole(PROJECT_ID, ORG_ID, 'role.x', 'Role X')).rejects.toThrow('HTTP 403');
  });

  it('retries once on 500 then succeeds', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(err(500))
      .mockResolvedValueOnce(ok({ details: {} }));
    const result = await addProjectRole(PROJECT_ID, ORG_ID, 'role.x', 'Role X');
    expect(result.created).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('throws on network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(addProjectRole(PROJECT_ID, ORG_ID, 'role.x', 'Role X')).rejects.toThrow('unreachable');
  });

  it('sends correct path with encoded projectId', async () => {
    vi.mocked(fetch).mockResolvedValue(ok());
    await addProjectRole('proj/with/slash', ORG_ID, 'role.x', 'X');
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/management/v1/projects/proj%2Fwith%2Fslash/roles');
  });
});

describe('removeProjectRole', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('resolves on 200', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ details: {} }));
    await expect(removeProjectRole(PROJECT_ID, ORG_ID, 'role.x')).resolves.toBeUndefined();
  });

  it('resolves on second 200 (idempotent — S1 gate: remove is always 200)', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ details: {} }));
    await removeProjectRole(PROJECT_ID, ORG_ID, 'role.x');
    await removeProjectRole(PROJECT_ID, ORG_ID, 'role.x'); // second call
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2); // two separate calls, both succeed
  });

  it('throws on 403', async () => {
    vi.mocked(fetch).mockResolvedValue(err(403));
    await expect(removeProjectRole(PROJECT_ID, ORG_ID, 'role.x')).rejects.toThrow('HTTP 403');
  });

  it('sends DELETE to correct path', async () => {
    vi.mocked(fetch).mockResolvedValue(ok());
    await removeProjectRole(PROJECT_ID, ORG_ID, 'role.key');
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(url).toContain(`/management/v1/projects/${PROJECT_ID}/roles/role.key`);
  });
});

describe('addUserGrant', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns grantId and created=true on 200', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ userGrantId: 'grant-abc' }));
    const result = await addUserGrant('user-1', ORG_ID, PROJECT_ID, ['role.a']);
    expect(result.grantId).toBe('grant-abc');
    expect(result.created).toBe(true);
  });

  it('returns created=false with empty grantId on 409 (S1: grant exists)', async () => {
    vi.mocked(fetch).mockResolvedValue(err(409, 'User grant already exists'));
    const result = await addUserGrant('user-1', ORG_ID, PROJECT_ID, ['role.a']);
    expect(result.created).toBe(false);
    expect(result.grantId).toBe('');
  });

  it('throws on 400 Bad Request', async () => {
    vi.mocked(fetch).mockResolvedValue(err(400, 'Invalid project'));
    await expect(addUserGrant('user-1', ORG_ID, PROJECT_ID, ['role.a'])).rejects.toThrow('HTTP 400');
  });

  it('sends correct body with projectId and roleKeys', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ userGrantId: 'g1' }));
    await addUserGrant('user-1', ORG_ID, PROJECT_ID, ['role.a', 'role.b']);
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { projectId: string; roleKeys: string[] };
    expect(body.projectId).toBe(PROJECT_ID);
    expect(body.roleKeys).toEqual(['role.a', 'role.b']);
  });
});

describe('updateUserGrant', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('resolves on 200', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ details: {} }));
    await expect(updateUserGrant('user-1', ORG_ID, 'grant-1', ['role.a', 'role.c'])).resolves.toBeUndefined();
  });

  it('sends PUT with full roleKeys body', async () => {
    vi.mocked(fetch).mockResolvedValue(ok());
    await updateUserGrant('user-1', ORG_ID, 'grant-1', ['role.a', 'role.c']);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(url).toContain('/management/v1/users/user-1/grants/grant-1');
    const body = JSON.parse(init.body as string) as { roleKeys: string[] };
    expect(body.roleKeys).toEqual(['role.a', 'role.c']);
  });

  it('throws on 404 (grant not found)', async () => {
    vi.mocked(fetch).mockResolvedValue(err(404, 'Grant not found'));
    await expect(updateUserGrant('user-1', ORG_ID, 'bad-grant', ['role.a'])).rejects.toThrow('HTTP 404');
  });
});

describe('removeUserGrant', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('resolves on 200', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ details: {} }));
    await expect(removeUserGrant('user-1', ORG_ID, 'grant-1')).resolves.toBeUndefined();
  });

  it('resolves on 404 (already removed — S1 gate idempotency)', async () => {
    vi.mocked(fetch).mockResolvedValue(err(404, 'User grant not found'));
    // 404 should NOT throw — treated as success
    await expect(removeUserGrant('user-1', ORG_ID, 'grant-1')).resolves.toBeUndefined();
  });

  it('throws on 403', async () => {
    vi.mocked(fetch).mockResolvedValue(err(403, 'Forbidden'));
    await expect(removeUserGrant('user-1', ORG_ID, 'grant-1')).rejects.toThrow('HTTP 403');
  });

  it('sends DELETE to correct path', async () => {
    vi.mocked(fetch).mockResolvedValue(ok());
    await removeUserGrant('user-1', ORG_ID, 'grant-1');
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(url).toContain('/management/v1/users/user-1/grants/grant-1');
  });
});

describe('listProjectRoles', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns parsed roles on 200', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({
      result: [
        { roleKey: 'role.a', displayName: 'Role A', group: 'grp' },
        { roleKey: 'role.b', displayName: 'Role B', group: '' },
      ],
    }));
    const roles = await listProjectRoles(PROJECT_ID, ORG_ID);
    expect(roles).toHaveLength(2);
    expect(roles[0]!.roleKey).toBe('role.a');
    expect(roles[1]!.group).toBe('');
  });

  it('returns empty array when result is absent', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({}));
    const roles = await listProjectRoles(PROJECT_ID, ORG_ID);
    expect(roles).toEqual([]);
  });

  it('throws on 403', async () => {
    vi.mocked(fetch).mockResolvedValue(err(403));
    await expect(listProjectRoles(PROJECT_ID, ORG_ID)).rejects.toThrow('HTTP 403');
  });

  it('sends POST search request', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ result: [] }));
    await listProjectRoles(PROJECT_ID, ORG_ID);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(url).toContain(`/management/v1/projects/${PROJECT_ID}/roles/_search`);
  });
});
