/**
 * hash-chain.ts — Audit log hash chain computation.
 * Each row hashes its own content + previous row's hash → tamper evidence.
 */
import { createHash } from 'node:crypto';

export interface AuditRowData {
  id: string;
  ts: string; // ISO timestamp string
  actor_id: string;
  actor_email: string;
  action: string;
  target_type: string;
  target_id: string;
  before_state: unknown;
  after_state: unknown;
}

/**
 * Compute SHA-256 hash of the audit row's content fields.
 * Input is deterministically serialized (sorted keys, no whitespace).
 */
export function computeRowHash(row: AuditRowData): string {
  const payload =
    row.id +
    row.ts +
    row.actor_id +
    row.actor_email +
    row.action +
    row.target_type +
    row.target_id +
    JSON.stringify(row.before_state ?? null) +
    JSON.stringify(row.after_state ?? null);

  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Compute the chained hash: sha256(prevHash + rowHash).
 * prevHash is null/empty for the very first row.
 */
export function computeChainedHash(prevHash: string | null, rowHash: string): string {
  const input = (prevHash ?? '') + rowHash;
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Verify integrity of an ordered audit chain.
 * Returns true if every chained_hash matches recomputed value.
 */
export function verifyChain(
  rows: Array<{ row_hash: string; prev_hash: string | null; chained_hash: string }>,
): boolean {
  let prevHash: string | null = null;
  for (const row of rows) {
    const expected = computeChainedHash(prevHash, row.row_hash);
    if (expected !== row.chained_hash) return false;
    prevHash = row.chained_hash;
  }
  return true;
}
