/**
 * role-sync.test.ts — Unit tests for role-sync service.
 * Verifies: DB tx atomicity, outbox enqueue, rollback on error.
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

// Hoisted mock state for pool client
const { mockQuery, mockConnect, mockRelease } = vi.hoisted(() => {
  const mockQuery = vi.fn();
  const mockRelease = vi.fn();
  const mockConnect = vi.fn();
  return { mockQuery, mockConnect, mockRelease };
});

vi.mock('../../src/db/writer-pool.js', () => ({
  writerPool: { connect: mockConnect },
}));

vi.mock('../../src/db/queries/roles.js', () => ({
  createRole: vi.fn().mockResolvedValue({
    id: 'role-uuid-1',
    key: 'test.role',
    description: 'A test role',
    parent_key: null,
    created_at: '2026-08-25T00:00:00Z',
    updated_at: '2026-08-25T00:00:00Z',
  }),
  deleteRole: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/db/queries/resolve-epoch.js', () => ({
  bumpResolveEpoch: vi.fn().mockResolvedValue(2),
}));

vi.mock('../../src/db/queries/outbox.js', () => ({
  enqueueOutbox: vi.fn().mockResolvedValue({
    id: 'outbox-1',
    idempotency_key: 'key-abc',
    inserted: true,
  }),
}));

vi.mock('../../src/lib/zitadel-mgmt-client.js', () => ({
  listUserGrants: vi.fn().mockResolvedValue([]),
}));

import { createRoleWithSync, deleteRoleWithSync } from '../../src/services/role-sync.js';
import { createRole as dbCreateRole, deleteRole as dbDeleteRole } from '../../src/db/queries/roles.js';
import { enqueueOutbox } from '../../src/db/queries/outbox.js';
import { bumpResolveEpoch } from '../../src/db/queries/resolve-epoch.js';

describe('createRoleWithSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock client returned by pool.connect()
    mockConnect.mockResolvedValue({
      query: mockQuery.mockResolvedValue({}),
      release: mockRelease,
    });
  });

  it('returns role + outbox result on success', async () => {
    const result = await createRoleWithSync({ key: 'test.role', description: 'A test role' }, 'corr-1');

    expect(result.role.key).toBe('test.role');
    expect(result.outbox.id).toBe('outbox-1');
    expect(result.outbox.inserted).toBe(true);
  });

  it('calls BEGIN and COMMIT within transaction', async () => {
    await createRoleWithSync({ key: 'test.role' });

    const calls = mockQuery.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
  });

  it('calls dbCreateRole and enqueueOutbox within transaction', async () => {
    await createRoleWithSync({ key: 'test.role', description: 'desc' });

    expect(dbCreateRole).toHaveBeenCalledOnce();
    expect(enqueueOutbox).toHaveBeenCalledOnce();

    const [, operation, args] = (enqueueOutbox as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown, string, Record<string, unknown>, string, string?,
    ];
    expect(operation).toBe('add_project_role');
    expect(args['projectId']).toBe('proj-abc');
    expect(args['roleKey']).toBe('test.role');
  });

  it('rolls back and throws if createRole fails', async () => {
    (dbCreateRole as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB constraint violation'));

    await expect(createRoleWithSync({ key: 'bad.role' })).rejects.toThrow('DB constraint violation');

    const calls = mockQuery.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  it('releases pool client even on error', async () => {
    (dbCreateRole as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));

    await expect(createRoleWithSync({ key: 'x' })).rejects.toThrow();
    expect(mockRelease).toHaveBeenCalledOnce();
  });
});

describe('deleteRoleWithSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue({
      query: mockQuery.mockResolvedValue({}),
      release: mockRelease,
    });
    (dbDeleteRole as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  });

  it('returns deleted=true and outbox result on success', async () => {
    const result = await deleteRoleWithSync('test.role', 'corr-2');

    expect(result.deleted).toBe(true);
    expect(result.outbox.id).toBe('outbox-1');
  });

  it('enqueues remove_project_role outbox event', async () => {
    await deleteRoleWithSync('test.role');

    const [, operation, args] = (enqueueOutbox as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown, string, Record<string, unknown>, string, string?,
    ];
    expect(operation).toBe('remove_project_role');
    expect(args['roleKey']).toBe('test.role');
    expect(args['projectId']).toBe('proj-abc');
  });

  it('bumps resolve epoch within transaction', async () => {
    await deleteRoleWithSync('test.role');
    expect(bumpResolveEpoch).toHaveBeenCalledOnce();
  });

  it('returns deleted=false without outbox if role not found in DB', async () => {
    (dbDeleteRole as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const result = await deleteRoleWithSync('nonexistent.role');

    expect(result.deleted).toBe(false);
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });

  it('rolls back and throws if enqueueOutbox fails', async () => {
    (enqueueOutbox as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('outbox insert failed'));

    await expect(deleteRoleWithSync('test.role')).rejects.toThrow('outbox insert failed');

    const calls = mockQuery.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('ROLLBACK');
  });
});
