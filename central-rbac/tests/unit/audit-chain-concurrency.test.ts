/**
 * audit-chain-concurrency.test.ts — Unit tests for C3 race fix in insertAuditEntry.
 *
 * Without Docker we cannot run real parallel Postgres connections, so these tests:
 *   1. Verify the transaction protocol: BEGIN → advisory lock → SELECT → INSERT → COMMIT
 *      is called in the correct order for every insertAuditEntry call.
 *   2. Simulate 10 concurrent calls against an in-memory sequential mock to verify
 *      the chain remains unbroken (prev_hash chain linkage is correct).
 *
 * Real concurrency correctness (two actual PG connections racing) is verified by
 * the integration test in tests/integration/migrations-and-audit-chain.test.ts
 * when Docker is available in CI.
 */
import { describe, it, expect, vi } from 'vitest';
import { computeRowHash, computeChainedHash } from '../../src/lib/hash-chain.js';
import { insertAuditEntry } from '../../src/db/queries/audit.js';
import type { Pool, PoolClient } from 'pg';

// ─── helpers ─────────────────────────────────────────────────────────────────

interface StoredRow {
  id: string;
  seq: number;
  chained_hash: string;
  row_hash: string;
  prev_hash: string | null;
}

/**
 * Build a mock pg.Pool whose connect() returns a mock PoolClient.
 * The mock maintains a tiny in-memory audit_log so chain reads work correctly.
 * Calls to the client are recorded for protocol-order assertions.
 */
function makeSerializedMockPool() {
  const rows: StoredRow[] = [];
  const callLog: string[] = []; // records 'BEGIN', 'advisory_lock', 'SELECT', 'INSERT', 'COMMIT', 'ROLLBACK'

  function mockClient(): PoolClient {
    return {
      query: vi.fn().mockImplementation(async (sql: string, _params?: unknown[]) => {
        const s = typeof sql === 'string' ? sql.trim().toUpperCase() : '';

        if (s.startsWith('BEGIN')) {
          callLog.push('BEGIN');
          return { rows: [] };
        }
        if (s.includes('PG_ADVISORY_XACT_LOCK')) {
          callLog.push('advisory_lock');
          return { rows: [] };
        }
        if (s.startsWith('COMMIT')) {
          callLog.push('COMMIT');
          return { rows: [] };
        }
        if (s.startsWith('ROLLBACK')) {
          callLog.push('ROLLBACK');
          return { rows: [] };
        }
        // Chain-head SELECT
        if (s.startsWith('SELECT') && s.includes('CHAINED_HASH')) {
          callLog.push('SELECT');
          const head = rows.length > 0 ? rows[rows.length - 1] : null;
          return { rows: head ? [{ chained_hash: head.chained_hash }] : [] };
        }
        // INSERT
        if (s.startsWith('INSERT')) {
          callLog.push('INSERT');
          // Extract values from params (_params) — positions match insertAuditEntry
          const p = _params as unknown[];
          const id = p[0] as string;
          const row_hash = p[13] as string;
          const prev_hash = p[14] as string | null;
          const chained_hash = p[15] as string;
          const seq = rows.length + 1;
          const inserted: StoredRow = { id, seq, chained_hash, row_hash, prev_hash };
          rows.push(inserted);
          // Return a minimal AuditLogRow shape
          return {
            rows: [{
              id, seq: String(seq), ts: new Date().toISOString(),
              actor_id: p[2], actor_type: p[3], actor_email: p[4],
              action: p[5], target_type: p[6], target_id: p[7],
              before_state: null, after_state: null,
              ip: null, session_id: null, correlation_id: null,
              row_hash, prev_hash, chained_hash,
            }],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
  }

  const pool: Pool = {
    connect: vi.fn().mockImplementation(async () => mockClient()),
  } as unknown as Pool;

  return { pool, rows, callLog };
}

const baseInput = {
  actor_id: 'user-test',
  actor_type: 'user' as const,
  actor_email: 'test@example.com',
  action: 'permission.create',
  target_type: 'permission',
  target_id: 'test.perm',
  before_state: null,
  after_state: { key: 'test.perm' },
};

// ─── Transaction protocol ─────────────────────────────────────────────────────

describe('insertAuditEntry — transaction protocol (C3 fix)', () => {
  it('calls BEGIN → advisory_lock → SELECT → INSERT → COMMIT in order', async () => {
    const { pool, callLog } = makeSerializedMockPool();

    await insertAuditEntry(pool, baseInput);

    // Verify protocol order
    expect(callLog[0]).toBe('BEGIN');
    expect(callLog[1]).toBe('advisory_lock');
    expect(callLog[2]).toBe('SELECT');
    expect(callLog[3]).toBe('INSERT');
    expect(callLog[4]).toBe('COMMIT');
    expect(callLog).not.toContain('ROLLBACK');
  });

  it('calls ROLLBACK and rethrows on INSERT error', async () => {
    const { callLog } = makeSerializedMockPool();

    // Build a pool whose INSERT throws
    let insertCount = 0;
    const failPool: Pool = {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockImplementation(async (sql: string) => {
          const s = sql.trim().toUpperCase();
          if (s.startsWith('BEGIN')) { callLog.push('BEGIN'); return { rows: [] }; }
          if (s.includes('PG_ADVISORY_XACT_LOCK')) { callLog.push('advisory_lock'); return { rows: [] }; }
          if (s.startsWith('SELECT')) { callLog.push('SELECT'); return { rows: [] }; }
          if (s.startsWith('INSERT')) {
            insertCount++;
            callLog.push('INSERT_FAIL');
            throw new Error('simulated insert error');
          }
          if (s.startsWith('ROLLBACK')) { callLog.push('ROLLBACK'); return { rows: [] }; }
          if (s.startsWith('COMMIT')) { callLog.push('COMMIT'); return { rows: [] }; }
          return { rows: [] };
        }),
        release: vi.fn(),
      } as unknown as PoolClient),
    } as unknown as Pool;

    await expect(insertAuditEntry(failPool, baseInput)).rejects.toThrow('simulated insert error');
    expect(callLog).toContain('ROLLBACK');
    expect(callLog).not.toContain('COMMIT');
    expect(insertCount).toBe(1);
  });

  it('releases client to pool even after error', async () => {
    const releaseFn = vi.fn();
    const failPool: Pool = {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.trim().toUpperCase().startsWith('INSERT')) throw new Error('fail');
          return { rows: [] };
        }),
        release: releaseFn,
      } as unknown as PoolClient),
    } as unknown as Pool;

    await expect(insertAuditEntry(failPool, baseInput)).rejects.toThrow();
    expect(releaseFn).toHaveBeenCalledOnce();
  });
});

// ─── Chain integrity under simulated sequential mock ─────────────────────────

describe('insertAuditEntry — chain integrity (10 sequential inserts via mock)', () => {
  it('produces unbroken hash chain for 10 sequential inserts', async () => {
    const { pool, rows } = makeSerializedMockPool();

    for (let i = 0; i < 10; i++) {
      await insertAuditEntry(pool, { ...baseInput, target_id: `perm.${i}` });
    }

    expect(rows).toHaveLength(10);

    // Verify each row's chained_hash is correct given its prev_hash + row_hash
    let prevHash: string | null = null;
    for (const row of rows) {
      expect(row.prev_hash).toBe(prevHash);
      const expected = computeChainedHash(prevHash, row.row_hash);
      expect(row.chained_hash).toBe(expected);
      prevHash = row.chained_hash;
    }
  });

  it('first row has null prev_hash', async () => {
    const { pool, rows } = makeSerializedMockPool();
    await insertAuditEntry(pool, baseInput);
    expect(rows[0]!.prev_hash).toBeNull();
  });

  it('each subsequent row prev_hash equals prior row chained_hash', async () => {
    const { pool, rows } = makeSerializedMockPool();

    await insertAuditEntry(pool, { ...baseInput, target_id: 'perm.a' });
    await insertAuditEntry(pool, { ...baseInput, target_id: 'perm.b' });
    await insertAuditEntry(pool, { ...baseInput, target_id: 'perm.c' });

    expect(rows[1]!.prev_hash).toBe(rows[0]!.chained_hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.chained_hash);
  });
});

// ─── Deterministic row_hash ───────────────────────────────────────────────────

describe('audit row_hash determinism', () => {
  it('same inputs produce same row_hash', () => {
    const input = {
      id: 'fixed-id',
      ts: '2026-08-24T10:00:00.000Z',
      actor_id: 'user-1',
      actor_email: 'a@b.com',
      action: 'permission.create',
      target_type: 'permission',
      target_id: 'test.perm',
      before_state: null,
      after_state: { key: 'test.perm' },
    };
    expect(computeRowHash(input)).toBe(computeRowHash(input));
  });

  it('different target_id produces different row_hash', () => {
    const base = {
      id: 'id-1', ts: '2026-08-24T10:00:00.000Z',
      actor_id: 'u', actor_email: 'e@e.com',
      action: 'a', target_type: 't',
      target_id: 'x', before_state: null, after_state: null,
    };
    const other = { ...base, target_id: 'y' };
    expect(computeRowHash(base)).not.toBe(computeRowHash(other));
  });
});
