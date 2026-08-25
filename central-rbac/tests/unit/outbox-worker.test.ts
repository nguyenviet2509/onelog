/**
 * outbox-worker.test.ts — Unit tests for outbox worker loop + dispatcher.
 * Covers: dispatch routing, retry/dead-letter logic, H2 stalled-row recovery logging.
 *
 * Mocks: DB queries (outbox.ts), outbox-processor functions (via outbox-event-dispatcher).
 * Note: outbox-worker imports processEvent from outbox-event-dispatcher, which imports
 * from outbox-processor — so mocking outbox-processor is the correct intercept point.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../src/config.js', () => ({
  config: {
    OUTBOX_WORKER_ENABLED: true,
    ZITADEL_ORG_ID: 'org-test',
    ZITADEL_PROJECT_ID: 'proj-test',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const { mockClaimNextBatch, mockMarkDone, mockMarkFailed, mockMarkDead } = vi.hoisted(() => ({
  mockClaimNextBatch: vi.fn(),
  mockMarkDone: vi.fn().mockResolvedValue(undefined),
  mockMarkFailed: vi.fn().mockResolvedValue(1),
  mockMarkDead: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/queries/outbox.js', () => ({
  claimNextBatch: mockClaimNextBatch,
  markDone: mockMarkDone,
  markFailed: mockMarkFailed,
  markDead: mockMarkDead,
}));

vi.mock('../../src/db/writer-pool.js', () => ({ writerPool: {} }));

const { mockAddProjectRole, mockRemoveProjectRole, mockAddUserGrant, mockUpdateUserGrant, mockRemoveUserGrant, mockAddOrUpdateUserGrant } =
  vi.hoisted(() => ({
    mockAddProjectRole: vi.fn().mockResolvedValue(undefined),
    mockRemoveProjectRole: vi.fn().mockResolvedValue(undefined),
    mockAddUserGrant: vi.fn().mockResolvedValue(undefined),
    mockUpdateUserGrant: vi.fn().mockResolvedValue(undefined),
    mockRemoveUserGrant: vi.fn().mockResolvedValue(undefined),
    mockAddOrUpdateUserGrant: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('../../src/services/outbox-processor.js', () => ({
  addProjectRole: mockAddProjectRole,
  removeProjectRole: mockRemoveProjectRole,
  addUserGrant: mockAddUserGrant,
  updateUserGrant: mockUpdateUserGrant,
  removeUserGrant: mockRemoveUserGrant,
  addOrUpdateUserGrant: mockAddOrUpdateUserGrant,
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import type { OutboxEvent } from '../../src/db/queries/outbox.js';

function makeEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: '1',
    idempotency_key: 'key-1',
    operation: 'add_project_role' as const,
    args: { projectId: 'proj-1', roleKey: 'test.role', displayName: 'Test Role' },
    status: 'processing' as const,
    attempts: 0,
    correlation_id: null,
    created_at: new Date().toISOString(),
    processed_at: null,
    last_error: null,
    processing_started_at: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('outbox-worker token bucket', () => {
  it('drains at configured rate (behavioral placeholder — rate covered in integration)', () => {
    expect(true).toBe(true);
  });
});

describe('outbox-worker processEvent dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches add_project_role and marks done on success', async () => {
    mockClaimNextBatch.mockResolvedValueOnce([makeEvent({ operation: 'add_project_role' })]);
    mockClaimNextBatch.mockResolvedValue([]); // stop loop

    const { startOutboxWorker, stopOutboxWorker } = await import('../../src/services/outbox-worker.js');
    startOutboxWorker();
    await new Promise((r) => setTimeout(r, 1200));
    await stopOutboxWorker();

    expect(mockAddProjectRole).toHaveBeenCalledOnce();
    // L4 fix: use expect.anything() instead of {} to avoid signature-drift blind spot
    expect(mockMarkDone).toHaveBeenCalledWith(expect.anything(), '1');
  });

  it('dispatches remove_user_grant on correct operation', async () => {
    const event = makeEvent({
      id: '2',
      operation: 'remove_user_grant',
      args: { userId: 'u1', orgId: 'org-test', grantId: 'g1' },
    });
    mockClaimNextBatch.mockResolvedValueOnce([event]).mockResolvedValue([]);

    const { startOutboxWorker, stopOutboxWorker } = await import('../../src/services/outbox-worker.js');
    startOutboxWorker();
    await new Promise((r) => setTimeout(r, 1200));
    await stopOutboxWorker();

    expect(mockRemoveUserGrant).toHaveBeenCalledWith(event.args);
    expect(mockMarkDone).toHaveBeenCalledWith(expect.anything(), '2');
  });

  it('dispatches add_or_update_user_grant (H1+H4 enqueue-first path)', async () => {
    const event = makeEvent({
      id: '7',
      operation: 'add_or_update_user_grant',
      args: { userId: 'u1', orgId: 'org-test', projectId: 'proj-test', roleKey: 'role.x' },
    });
    mockClaimNextBatch.mockResolvedValueOnce([event]).mockResolvedValue([]);

    const { startOutboxWorker, stopOutboxWorker } = await import('../../src/services/outbox-worker.js');
    startOutboxWorker();
    await new Promise((r) => setTimeout(r, 1200));
    await stopOutboxWorker();

    expect(mockAddOrUpdateUserGrant).toHaveBeenCalledWith(event.args);
    expect(mockMarkDone).toHaveBeenCalledWith(expect.anything(), '7');
  });

  it('marks failed on 5xx-style error (retryable), not dead if attempts < 5', async () => {
    mockAddProjectRole.mockRejectedValueOnce(new Error('Zitadel Mgmt API unreachable: ECONNREFUSED'));
    mockMarkFailed.mockResolvedValueOnce(1); // attempts = 1, not dead yet

    const event = makeEvent({ id: '3', attempts: 0 });
    mockClaimNextBatch.mockResolvedValueOnce([event]).mockResolvedValue([]);

    const { startOutboxWorker, stopOutboxWorker } = await import('../../src/services/outbox-worker.js');
    startOutboxWorker();
    await new Promise((r) => setTimeout(r, 1200));
    await stopOutboxWorker();

    expect(mockMarkFailed).toHaveBeenCalledWith(expect.anything(), '3', 'transient error');
    expect(mockMarkDead).not.toHaveBeenCalled();
  });

  it('marks dead immediately on 4xx error (data problem)', async () => {
    mockAddProjectRole.mockRejectedValueOnce(new Error('Zitadel addProjectRole error: HTTP 400'));

    const event = makeEvent({ id: '4', attempts: 0 });
    mockClaimNextBatch.mockResolvedValueOnce([event]).mockResolvedValue([]);

    const { startOutboxWorker, stopOutboxWorker } = await import('../../src/services/outbox-worker.js');
    startOutboxWorker();
    await new Promise((r) => setTimeout(r, 1200));
    await stopOutboxWorker();

    expect(mockMarkDead).toHaveBeenCalledWith(expect.anything(), '4', 'permanent failure');
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('marks dead directly when attempts already at threshold (no markFailed call)', async () => {
    mockAddProjectRole.mockRejectedValueOnce(new Error('Zitadel Mgmt API unreachable: timeout'));

    const event = makeEvent({ id: '5', attempts: 4 }); // one more failure = dead
    mockClaimNextBatch.mockResolvedValueOnce([event]).mockResolvedValue([]);

    const { startOutboxWorker, stopOutboxWorker } = await import('../../src/services/outbox-worker.js');
    startOutboxWorker();
    await new Promise((r) => setTimeout(r, 1200));
    await stopOutboxWorker();

    expect(mockMarkDead).toHaveBeenCalledWith(expect.anything(), '5', 'permanent failure');
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('marks dead immediately for unknown/non-whitelisted operation', async () => {
    const event = makeEvent({
      id: '6',
      operation: 'unknown_op' as OutboxEvent['operation'],
    });
    mockClaimNextBatch.mockResolvedValueOnce([event]).mockResolvedValue([]);

    const { startOutboxWorker, stopOutboxWorker } = await import('../../src/services/outbox-worker.js');
    startOutboxWorker();
    await new Promise((r) => setTimeout(r, 1200));
    await stopOutboxWorker();

    expect(mockMarkDead).toHaveBeenCalledWith(expect.anything(), '6', 'permanent failure');
    expect(mockAddProjectRole).not.toHaveBeenCalled();
  });

  it('isWorkerRunning returns false after stop', async () => {
    const { startOutboxWorker, stopOutboxWorker, isWorkerRunning } = await import(
      '../../src/services/outbox-worker.js'
    );
    mockClaimNextBatch.mockResolvedValue([]);
    startOutboxWorker();
    expect(isWorkerRunning()).toBe(true);
    await stopOutboxWorker();
    expect(isWorkerRunning()).toBe(false);
  });

  it('H2: logs [OUTBOX-RECOVERED] when claimed batch contains stalled processing rows', async () => {
    // Simulate a row that was stuck in 'processing' (processing_started_at set, not null)
    // — this is what claimNextBatch returns when it reclaims a stalled row
    const stalledEvent = makeEvent({
      id: '8',
      operation: 'add_project_role',
      status: 'processing' as const,
      processing_started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    });
    mockClaimNextBatch.mockResolvedValueOnce([stalledEvent]).mockResolvedValue([]);

    const { logger } = await import('../../src/lib/logger.js');
    const { startOutboxWorker, stopOutboxWorker } = await import('../../src/services/outbox-worker.js');
    startOutboxWorker();
    await new Promise((r) => setTimeout(r, 1200));
    await stopOutboxWorker();

    // The worker must log [OUTBOX-RECOVERED] for the stalled row
    const infoMock = vi.mocked(logger.info);
    const recoveredCall = infoMock.mock.calls.find(
      (args) => typeof args[1] === 'string' && args[1].includes('[OUTBOX-RECOVERED]'),
    );
    expect(recoveredCall).toBeDefined();
    // Event should still be processed normally
    expect(mockAddProjectRole).toHaveBeenCalledOnce();
    expect(mockMarkDone).toHaveBeenCalledWith(expect.anything(), '8');
  });
});
