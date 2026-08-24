/**
 * hash-chain.test.ts — Unit tests for audit log hash chain computation.
 */
import { describe, it, expect } from 'vitest';
import {
  computeRowHash,
  computeChainedHash,
  verifyChain,
  type AuditRowData,
} from '../../src/lib/hash-chain.js';

const sampleRow: AuditRowData = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  ts: '2026-08-24T10:00:00.000Z',
  actor_id: 'user-123',
  actor_email: 'test@example.com',
  action: 'permission.create',
  target_type: 'permission',
  target_id: 'onemcp.kb.read',
  before_state: null,
  after_state: { key: 'onemcp.kb.read', description: 'test' },
};

describe('computeRowHash', () => {
  it('returns a 64-char hex string', () => {
    const hash = computeRowHash(sampleRow);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for same input', () => {
    expect(computeRowHash(sampleRow)).toBe(computeRowHash(sampleRow));
  });

  it('differs when any field changes', () => {
    const modified = { ...sampleRow, action: 'permission.delete' };
    expect(computeRowHash(sampleRow)).not.toBe(computeRowHash(modified));
  });

  it('differs when actor_id changes', () => {
    const modified = { ...sampleRow, actor_id: 'user-999' };
    expect(computeRowHash(sampleRow)).not.toBe(computeRowHash(modified));
  });
});

describe('computeChainedHash', () => {
  it('returns a 64-char hex string', () => {
    const rowHash = computeRowHash(sampleRow);
    const chained = computeChainedHash(null, rowHash);
    expect(chained).toMatch(/^[a-f0-9]{64}$/);
  });

  it('null prevHash (first row) produces valid hash', () => {
    const rowHash = computeRowHash(sampleRow);
    const chained = computeChainedHash(null, rowHash);
    expect(chained).toBeDefined();
    expect(chained.length).toBe(64);
  });

  it('chained hash differs with different prevHash', () => {
    const rowHash = computeRowHash(sampleRow);
    const chain1 = computeChainedHash('aabbcc', rowHash);
    const chain2 = computeChainedHash('ddeeff', rowHash);
    expect(chain1).not.toBe(chain2);
  });
});

describe('verifyChain', () => {
  it('returns true for empty chain', () => {
    expect(verifyChain([])).toBe(true);
  });

  it('returns true for valid 1-row chain', () => {
    const rowHash = computeRowHash(sampleRow);
    const chainedHash = computeChainedHash(null, rowHash);
    expect(verifyChain([{ row_hash: rowHash, prev_hash: null, chained_hash: chainedHash }])).toBe(true);
  });

  it('returns true for valid 3-row chain', () => {
    const rows: Array<{ row_hash: string; prev_hash: string | null; chained_hash: string }> = [];
    let prevHash: string | null = null;

    for (let i = 0; i < 3; i++) {
      const rowData = { ...sampleRow, id: `id-${i}`, action: `action.${i}` };
      const row_hash = computeRowHash(rowData);
      const chained_hash = computeChainedHash(prevHash, row_hash);
      rows.push({ row_hash, prev_hash: prevHash, chained_hash });
      prevHash = chained_hash;
    }

    expect(verifyChain(rows)).toBe(true);
  });

  it('returns false if a row_hash is tampered', () => {
    const rowHash = computeRowHash(sampleRow);
    const chainedHash = computeChainedHash(null, rowHash);
    const tampered = [{ row_hash: 'tampered-hash', prev_hash: null, chained_hash: chainedHash }];
    expect(verifyChain(tampered)).toBe(false);
  });

  it('returns false if chained_hash is tampered', () => {
    const rowHash = computeRowHash(sampleRow);
    const tampered = [{ row_hash: rowHash, prev_hash: null, chained_hash: 'aaaa' }];
    expect(verifyChain(tampered)).toBe(false);
  });

  it('returns false if middle row is modified', () => {
    const rows: Array<{ row_hash: string; prev_hash: string | null; chained_hash: string }> = [];
    let prevHash: string | null = null;

    for (let i = 0; i < 3; i++) {
      const rowData = { ...sampleRow, id: `id-${i}` };
      const row_hash = computeRowHash(rowData);
      const chained_hash = computeChainedHash(prevHash, row_hash);
      rows.push({ row_hash, prev_hash: prevHash, chained_hash });
      prevHash = chained_hash;
    }

    // Tamper middle row
    rows[1]!.row_hash = 'tampered';
    expect(verifyChain(rows)).toBe(false);
  });
});
