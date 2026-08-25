/**
 * user-grant-sync.test.ts — Unit tests for user grant assignment/revocation service.
 *
 * H1+H4 fix (2026-08-25): assignRoleToUser no longer calls Zitadel — it always
 * enqueues 'add_or_update_user_grant'. Tests verify:
 *   - No listUserGrants call in assign hot path (H4)
 *   - Concurrent assigns for different roles both enqueue (H1 race prevention)
 *   - removeRoleFromUser still enqueues correct operations
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    ZITADEL_PROJECT_ID: 'proj-abc',
    ZITADEL_ORG_ID: 'org-abc',
  },
}));

vi.mock('../../src/db/writer-pool.js', () => ({ writerPool: {} }));

const { mockEnqueueOutbox, mockListUserGrants } = vi.hoisted(() => ({
  mockEnqueueOutbox: vi.fn().mockResolvedValue({ id: 'outbox-10', idempotency_key: 'k', inserted: true }),
  mockListUserGrants: vi.fn(),
}));

vi.mock('../../src/db/queries/outbox.js', () => ({ enqueueOutbox: mockEnqueueOutbox }));
vi.mock('../../src/lib/zitadel-mgmt-client.js', () => ({ listUserGrants: mockListUserGrants }));

import { assignRoleToUser, removeRoleFromUser } from '../../src/services/user-grant-sync.js';

describe('assignRoleToUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('always enqueues add_or_update_user_grant (enqueue-first — no Zitadel call)', async () => {
    // H4: listUserGrants must NOT be called — Zitadel read belongs in the worker
    const result = await assignRoleToUser('user-1', 'new.role', 'corr-1');

    expect(result.operation).toBe('add_or_update_user_grant');
    expect(mockListUserGrants).not.toHaveBeenCalled();
    expect(mockEnqueueOutbox).toHaveBeenCalledOnce();
  });

  it('enqueues correct args: userId, orgId, projectId, roleKey', async () => {
    await assignRoleToUser('user-1', 'new.role', 'corr-1');

    const [, operation, args] = mockEnqueueOutbox.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(operation).toBe('add_or_update_user_grant');
    expect(args['userId']).toBe('user-1');
    expect(args['roleKey']).toBe('new.role');
    expect(args['projectId']).toBe('proj-abc');
    expect(args['orgId']).toBe('org-abc');
  });

  it('produces different idempotency keys for different roleKeys (H1 concurrent safety)', async () => {
    // Concurrent assign for same user+project but different roles must produce
    // different idempotency keys so both events are stored (not collapsed by ON CONFLICT).
    await assignRoleToUser('user-1', 'role.y', 'corr-y');
    await assignRoleToUser('user-1', 'role.z', 'corr-z');

    expect(mockEnqueueOutbox).toHaveBeenCalledTimes(2);
    const key1 = mockEnqueueOutbox.mock.calls[0]![3] as string;
    const key2 = mockEnqueueOutbox.mock.calls[1]![3] as string;
    expect(key1).not.toBe(key2);
  });

  it('produces the same idempotency key for duplicate (userId, projectId, roleKey) — idempotent', async () => {
    // Same args twice → same key → ON CONFLICT DO NOTHING in DB (idempotency)
    await assignRoleToUser('user-1', 'role.a');
    await assignRoleToUser('user-1', 'role.a');

    const key1 = mockEnqueueOutbox.mock.calls[0]![3] as string;
    const key2 = mockEnqueueOutbox.mock.calls[1]![3] as string;
    expect(key1).toBe(key2);
  });

  it('concurrent assigns (Promise.all 5) all enqueue without Zitadel calls (H1 + H4)', async () => {
    // Simulates 5 concurrent admin requests assigning different roles to the same user.
    // All should enqueue without any listUserGrants call — advisory lock in worker prevents race.
    mockEnqueueOutbox
      .mockResolvedValueOnce({ id: '1', idempotency_key: 'k1', inserted: true })
      .mockResolvedValueOnce({ id: '2', idempotency_key: 'k2', inserted: true })
      .mockResolvedValueOnce({ id: '3', idempotency_key: 'k3', inserted: true })
      .mockResolvedValueOnce({ id: '4', idempotency_key: 'k4', inserted: true })
      .mockResolvedValueOnce({ id: '5', idempotency_key: 'k5', inserted: true });

    const results = await Promise.all([
      assignRoleToUser('user-1', 'role.a'),
      assignRoleToUser('user-1', 'role.b'),
      assignRoleToUser('user-1', 'role.c'),
      assignRoleToUser('user-1', 'role.d'),
      assignRoleToUser('user-1', 'role.e'),
    ]);

    // All 5 must have enqueued successfully
    expect(mockEnqueueOutbox).toHaveBeenCalledTimes(5);
    expect(mockListUserGrants).not.toHaveBeenCalled();
    // Each result carries the operation field
    for (const r of results) {
      expect(r.operation).toBe('add_or_update_user_grant');
    }
    // All idempotency keys must be distinct
    const keys = mockEnqueueOutbox.mock.calls.map((c) => c[3] as string);
    expect(new Set(keys).size).toBe(5);
  });

  it('returns outbox result from enqueueOutbox', async () => {
    mockEnqueueOutbox.mockResolvedValueOnce({ id: 'outbox-42', idempotency_key: 'k', inserted: false });

    const result = await assignRoleToUser('user-1', 'role.a');
    expect(result.outbox.id).toBe('outbox-42');
    expect(result.outbox.inserted).toBe(false);
  });
});

describe('removeRoleFromUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues remove_user_grant when no targetRoleKey (full removal)', async () => {
    const result = await removeRoleFromUser('user-1', 'grant-99', undefined, 'corr-2');

    expect(result.outbox.id).toBe('outbox-10');
    const [, operation, args] = mockEnqueueOutbox.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(operation).toBe('remove_user_grant');
    expect(args['grantId']).toBe('grant-99');
    expect(args['userId']).toBe('user-1');
  });

  it('enqueues update_user_grant with role removed when targetRoleKey given', async () => {
    mockListUserGrants.mockResolvedValue([
      { grantId: 'grant-99', projectId: 'proj-abc', orgId: 'org-abc', roleKeys: ['role.a', 'role.b'] },
    ]);

    await removeRoleFromUser('user-1', 'grant-99', 'role.a');

    const [, operation, args] = mockEnqueueOutbox.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(operation).toBe('update_user_grant');
    expect(args['grantId']).toBe('grant-99');
    const roleKeys = args['roleKeys'] as string[];
    expect(roleKeys).not.toContain('role.a');
    expect(roleKeys).toContain('role.b');
  });

  it('enqueues update with empty roleKeys if only role is removed', async () => {
    mockListUserGrants.mockResolvedValue([
      { grantId: 'grant-99', projectId: 'proj-abc', orgId: 'org-abc', roleKeys: ['role.only'] },
    ]);

    await removeRoleFromUser('user-1', 'grant-99', 'role.only');

    const [, , args] = mockEnqueueOutbox.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(args['roleKeys']).toEqual([]);
  });

  it('still enqueues update_user_grant for partial revoke even if listUserGrants throws', async () => {
    // Falls back to empty role set when Zitadel unreachable — still enqueues
    mockListUserGrants.mockRejectedValue(new Error('Zitadel unreachable'));

    await removeRoleFromUser('user-1', 'grant-99', 'role.a');

    const [, operation, args] = mockEnqueueOutbox.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(operation).toBe('update_user_grant');
    // roleKeys falls back to empty array (currentRoles = [])
    expect(args['roleKeys']).toEqual([]);
  });
});
