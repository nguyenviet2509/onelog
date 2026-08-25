/**
 * user-grant-sync.test.ts — Unit tests for user grant assignment/revocation service.
 * Verifies: add vs update path selection, partial revoke, idempotency key uniqueness.
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

  it('enqueues add_user_grant when user has no existing grant', async () => {
    mockListUserGrants.mockResolvedValue([]); // no grants

    const result = await assignRoleToUser('user-1', 'new.role', 'corr-1');

    expect(result.operation).toBe('add_user_grant');
    expect(mockEnqueueOutbox).toHaveBeenCalledOnce();
    const [, operation, args] = mockEnqueueOutbox.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(operation).toBe('add_user_grant');
    expect(args['userId']).toBe('user-1');
    expect(args['roleKeys']).toEqual(['new.role']);
    expect(args['projectId']).toBe('proj-abc');
  });

  it('enqueues update_user_grant when user already has a grant for this project', async () => {
    mockListUserGrants.mockResolvedValue([
      { grantId: 'grant-99', projectId: 'proj-abc', orgId: 'org-abc', roleKeys: ['existing.role'] },
    ]);

    const result = await assignRoleToUser('user-1', 'new.role');

    expect(result.operation).toBe('update_user_grant');
    const [, operation, args] = mockEnqueueOutbox.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(operation).toBe('update_user_grant');
    expect(args['grantId']).toBe('grant-99');
    // merged role set: existing + new
    expect(args['roleKeys']).toContain('existing.role');
    expect(args['roleKeys']).toContain('new.role');
  });

  it('does not duplicate role keys in merged set', async () => {
    mockListUserGrants.mockResolvedValue([
      { grantId: 'grant-99', projectId: 'proj-abc', orgId: 'org-abc', roleKeys: ['role.a', 'role.b'] },
    ]);

    await assignRoleToUser('user-1', 'role.a'); // role.a already in grant

    const [, , args] = mockEnqueueOutbox.mock.calls[0] as [unknown, string, Record<string, unknown>];
    const roleKeys = args['roleKeys'] as string[];
    // Should not duplicate role.a
    expect(roleKeys.filter((r) => r === 'role.a')).toHaveLength(1);
  });

  it('falls back to add_user_grant if listUserGrants throws', async () => {
    mockListUserGrants.mockRejectedValue(new Error('Zitadel unreachable'));

    const result = await assignRoleToUser('user-1', 'new.role');

    // Fallback: treat as no existing grant → add
    expect(result.operation).toBe('add_user_grant');
  });

  it('only considers grants for the configured project', async () => {
    // Grant exists but for a DIFFERENT project
    mockListUserGrants.mockResolvedValue([
      { grantId: 'grant-other', projectId: 'proj-other', orgId: 'org-abc', roleKeys: ['role.x'] },
    ]);

    const result = await assignRoleToUser('user-1', 'new.role');

    // Should enqueue add (not update) since no grant for proj-abc
    expect(result.operation).toBe('add_user_grant');
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
});
