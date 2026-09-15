/**
 * outbox-processor-user-grants-sync.test.ts — Unit tests for plan 260915-1615 phase 1.
 *
 * Verifies: after Zitadel PUT/POST/DELETE succeeds, worker mirrors grant state
 * vào rbac.user_grants (SDK /v2/resolve source of truth).
 *
 * Covers:
 *   - addOrUpdateUserGrant: INSERT rbac.user_grants after Zitadel add/update
 *   - updateUserGrant: surgical DELETE removed + INSERT added
 *   - removeUserGrant: DELETE previous roleKeys
 *   - Skip conditions: no app in rbac.apps, no role in rbac.roles
 *   - Backward compat: events missing projectId/previousRoleKeys don't throw
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { ZITADEL_ORG_ID: 'org-test', ZITADEL_PROJECT_ID: 'proj-test' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// Track SQL calls for verification
interface QueryCall {
  sql: string;
  params: unknown[];
}

const { queryCalls, mockClientQuery, mockWriterQuery, mockClientRelease } = vi.hoisted(() => {
  const calls: QueryCall[] = [];
  return {
    queryCalls: calls,
    mockClientQuery: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    }),
    mockWriterQuery: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    }),
    mockClientRelease: vi.fn(),
  };
});

vi.mock('../../src/db/writer-pool.js', () => ({
  writerPool: {
    connect: vi.fn(async () => ({
      query: mockClientQuery,
      release: mockClientRelease,
    })),
    query: mockWriterQuery,
  },
}));

// Zitadel client mocks — return success by default
const {
  mockClientAddUserGrant,
  mockClientUpdateUserGrant,
  mockClientRemoveUserGrant,
  mockListUserGrants,
} = vi.hoisted(() => ({
  mockClientAddUserGrant: vi.fn(async () => ({ grantId: 'g-new', created: true })),
  mockClientUpdateUserGrant: vi.fn(async () => undefined),
  mockClientRemoveUserGrant: vi.fn(async () => undefined),
  mockListUserGrants: vi.fn(async () => [] as Array<{ grantId: string; projectId: string; roleKeys: string[] }>),
}));

vi.mock('../../src/lib/zitadel-user-grants-client.js', () => ({
  addUserGrant: mockClientAddUserGrant,
  updateUserGrant: mockClientUpdateUserGrant,
  removeUserGrant: mockClientRemoveUserGrant,
  listUserGrants: mockListUserGrants,
}));

vi.mock('../../src/lib/zitadel-project-roles-client.js', () => ({
  addProjectRole: vi.fn(),
  updateProjectRole: vi.fn(),
  removeProjectRole: vi.fn(),
}));

vi.mock('../../src/lib/zitadel-user-search-client.js', () => ({
  getUserById: vi.fn(),
}));

vi.mock('../../src/lib/expand-role-hierarchy.js', () => ({
  expandRoleHierarchyV1Safe: vi.fn(async (_client: unknown, roles: string[]) => roles),
}));

import { addOrUpdateUserGrant, updateUserGrant, removeUserGrant } from '../../src/services/outbox-processor.js';

function resetCallLog(): void {
  queryCalls.length = 0;
}

/**
 * Configure mock pg client to return specific rows for SELECT queries.
 * SELECT ordering inside outbox-processor:
 *   addOrUpdateUserGrant: BEGIN → advisory_lock → (listUserGrants Zitadel) →
 *     mirrorGrantInsert: SELECT apps → SELECT roles → INSERT → COMMIT
 *
 * We queue responses per-call in mockClientQuery.
 */
function configureClientQueryResponses(responses: Array<{ rows: unknown[]; rowCount?: number }>): void {
  let idx = 0;
  mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params: params ?? [] });
    const res = responses[idx] ?? { rows: [], rowCount: 0 };
    idx++;
    return res;
  });
}

function configureWriterQueryResponses(responses: Array<{ rows: unknown[]; rowCount?: number }>): void {
  let idx = 0;
  mockWriterQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params: params ?? [] });
    const res = responses[idx] ?? { rows: [], rowCount: 0 };
    idx++;
    return res;
  });
}

// ── addOrUpdateUserGrant ─────────────────────────────────────────────────────

describe('addOrUpdateUserGrant — mirror rbac.user_grants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCallLog();
    mockListUserGrants.mockResolvedValue([]);
  });

  it('INSERTs into rbac.user_grants after Zitadel POST succeeds (new grant path)', async () => {
    // Mock sequence for new-grant path:
    //   1. BEGIN
    //   2. SELECT pg_advisory_xact_lock
    //   3. (Zitadel listUserGrants — mocked to return [])
    //   4. (Zitadel POST addUserGrant)
    //   5. mirrorGrantInsert: SELECT apps → returns app row
    //   6. mirrorGrantInsert: SELECT roles → returns role row
    //   7. mirrorGrantInsert: INSERT rbac.user_grants
    //   8. COMMIT
    configureClientQueryResponses([
      { rows: [] }, // BEGIN
      { rows: [] }, // advisory lock
      { rows: [{ id: 'app-uuid-1' }] }, // SELECT apps
      { rows: [{ key: 'onelog-agent.viewer' }] }, // SELECT roles
      { rows: [], rowCount: 1 }, // INSERT (1 row inserted)
      { rows: [] }, // COMMIT
    ]);

    await addOrUpdateUserGrant({
      userId: 'sub-kienvt',
      orgId: 'org-authway',
      projectId: 'zitadel-proj-789',
      roleKey: 'onelog-agent.viewer',
      grantorSub: 'sub-admin',
    });

    const insertCall = queryCalls.find((c) => c.sql.includes('INSERT INTO rbac.user_grants'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.params).toEqual([
      'sub-kienvt',
      'app-uuid-1',
      'onelog-agent.viewer',
      'sub-admin',
    ]);
    expect(mockClientAddUserGrant).toHaveBeenCalledOnce();
  });

  it('INSERTs after Zitadel PUT succeeds (existing grant merge path)', async () => {
    mockListUserGrants.mockResolvedValue([
      { grantId: 'g-1', projectId: 'zitadel-proj-789', roleKeys: ['onelog-agent.viewer'] },
    ]);
    configureClientQueryResponses([
      { rows: [] }, // BEGIN
      { rows: [] }, // advisory lock
      { rows: [{ id: 'app-uuid-1' }] },
      { rows: [{ key: 'onelog-agent.admin' }] },
      { rows: [], rowCount: 1 },
      { rows: [] }, // COMMIT
    ]);

    await addOrUpdateUserGrant({
      userId: 'sub-kienvt',
      orgId: 'org-authway',
      projectId: 'zitadel-proj-789',
      roleKey: 'onelog-agent.admin',
      grantorSub: 'sub-admin',
    });

    expect(mockClientUpdateUserGrant).toHaveBeenCalledOnce();
    const insertCall = queryCalls.find((c) => c.sql.includes('INSERT INTO rbac.user_grants'));
    expect(insertCall!.params[2]).toBe('onelog-agent.admin');
  });

  it("falls back to 'system' when grantorSub missing (backfill/legacy events)", async () => {
    configureClientQueryResponses([
      { rows: [] },
      { rows: [] },
      { rows: [{ id: 'app-uuid-1' }] },
      { rows: [{ key: 'role.x' }] },
      { rows: [], rowCount: 1 },
      { rows: [] },
    ]);

    await addOrUpdateUserGrant({
      userId: 'sub-1',
      orgId: 'org-1',
      projectId: 'proj-1',
      roleKey: 'role.x',
      // grantorSub omitted
    });

    const insertCall = queryCalls.find((c) => c.sql.includes('INSERT INTO rbac.user_grants'));
    expect(insertCall!.params[3]).toBe('system');
  });

  it('skips INSERT when app not in rbac.apps (legacy Zitadel-only)', async () => {
    configureClientQueryResponses([
      { rows: [] },
      { rows: [] },
      { rows: [] }, // SELECT apps → NOT FOUND
      { rows: [] },
    ]);

    await addOrUpdateUserGrant({
      userId: 'sub-1',
      orgId: 'org-1',
      projectId: 'zitadel-proj-legacy',
      roleKey: 'legacy.role',
    });

    const insertCall = queryCalls.find((c) => c.sql.includes('INSERT INTO rbac.user_grants'));
    expect(insertCall).toBeUndefined();
    expect(mockClientAddUserGrant).toHaveBeenCalledOnce(); // Zitadel still synced
  });

  it('skips INSERT when role not in rbac.roles (legacy Zitadel-only)', async () => {
    configureClientQueryResponses([
      { rows: [] },
      { rows: [] },
      { rows: [{ id: 'app-uuid-1' }] },
      { rows: [] }, // SELECT roles → NOT FOUND
      { rows: [] },
    ]);

    await addOrUpdateUserGrant({
      userId: 'sub-1',
      orgId: 'org-1',
      projectId: 'proj-1',
      roleKey: 'legacy.role',
    });

    const insertCall = queryCalls.find((c) => c.sql.includes('INSERT INTO rbac.user_grants'));
    expect(insertCall).toBeUndefined();
  });
});

// ── updateUserGrant ──────────────────────────────────────────────────────────

describe('updateUserGrant — mirror diff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCallLog();
  });

  it('DELETEs removed roles + INSERTs added roles based on previousRoleKeys diff', async () => {
    configureWriterQueryResponses([
      { rows: [{ id: 'app-uuid-1' }] }, // mirrorGrantDelete: SELECT apps
      { rows: [], rowCount: 1 }, // DELETE
      { rows: [{ id: 'app-uuid-1' }] }, // mirrorGrantInsert: SELECT apps
      { rows: [{ key: 'role.c' }] }, // SELECT roles
      { rows: [], rowCount: 1 }, // INSERT
    ]);

    await updateUserGrant({
      userId: 'sub-1',
      orgId: 'org-1',
      grantId: 'g-1',
      roleKeys: ['role.b', 'role.c'], // final desired set
      projectId: 'proj-1',
      previousRoleKeys: ['role.a', 'role.b'], // what was there before
      grantorSub: 'sub-admin',
    });

    expect(mockClientUpdateUserGrant).toHaveBeenCalledOnce();

    // Verify DELETE was called with removed role
    const deleteCall = queryCalls.find((c) => c.sql.includes('DELETE FROM rbac.user_grants'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.params[2]).toEqual(['role.a']);

    // Verify INSERT was called for added role
    const insertCall = queryCalls.find((c) => c.sql.includes('INSERT INTO rbac.user_grants'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.params[2]).toBe('role.c');
  });

  it('skips mirror when projectId missing (legacy queued event)', async () => {
    await updateUserGrant({
      userId: 'sub-1',
      orgId: 'org-1',
      grantId: 'g-1',
      roleKeys: ['role.a'],
      // no projectId
    });

    expect(mockClientUpdateUserGrant).toHaveBeenCalledOnce();
    const deleteCall = queryCalls.find((c) => c.sql.includes('DELETE FROM rbac.user_grants'));
    const insertCall = queryCalls.find((c) => c.sql.includes('INSERT INTO rbac.user_grants'));
    expect(deleteCall).toBeUndefined();
    expect(insertCall).toBeUndefined();
  });
});

// ── removeUserGrant ──────────────────────────────────────────────────────────

describe('removeUserGrant — mirror DELETE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCallLog();
  });

  it('DELETEs rbac.user_grants matching previousRoleKeys after Zitadel DELETE', async () => {
    configureWriterQueryResponses([
      { rows: [{ id: 'app-uuid-1' }] }, // SELECT apps
      { rows: [], rowCount: 2 }, // DELETE
    ]);

    await removeUserGrant({
      userId: 'sub-1',
      orgId: 'org-1',
      grantId: 'g-1',
      projectId: 'proj-1',
      previousRoleKeys: ['role.a', 'role.b'],
    });

    expect(mockClientRemoveUserGrant).toHaveBeenCalledOnce();
    const deleteCall = queryCalls.find((c) => c.sql.includes('DELETE FROM rbac.user_grants'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.params).toEqual(['sub-1', 'app-uuid-1', ['role.a', 'role.b']]);
  });

  it('skips mirror when projectId missing (legacy queued event)', async () => {
    await removeUserGrant({
      userId: 'sub-1',
      orgId: 'org-1',
      grantId: 'g-1',
    });

    expect(mockClientRemoveUserGrant).toHaveBeenCalledOnce();
    const deleteCall = queryCalls.find((c) => c.sql.includes('DELETE FROM rbac.user_grants'));
    expect(deleteCall).toBeUndefined();
  });

  it('skips mirror when previousRoleKeys empty (unknown state, safer to noop)', async () => {
    await removeUserGrant({
      userId: 'sub-1',
      orgId: 'org-1',
      grantId: 'g-1',
      projectId: 'proj-1',
      previousRoleKeys: [],
    });

    expect(mockClientRemoveUserGrant).toHaveBeenCalledOnce();
    const deleteCall = queryCalls.find((c) => c.sql.includes('DELETE FROM rbac.user_grants'));
    expect(deleteCall).toBeUndefined();
  });
});
