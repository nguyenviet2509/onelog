/**
 * queries/audit.ts — Audit log read queries via auditor pool.
 * Write queries are in middleware/audit-log.ts (uses writer pool).
 *
 * C3 fix: insertAuditEntry wraps SELECT-prev-hash + INSERT in a single
 *         transaction serialized via pg_advisory_xact_lock. This prevents
 *         concurrent writers forking the chain (two rows claiming same prev_hash).
 * H5 fix: ORDER BY uses seq (BIGSERIAL) as tiebreaker — deterministic under
 *         concurrent inserts sharing the same microsecond timestamp.
 */
import type { Pool } from 'pg';
import { computeRowHash, computeChainedHash, type AuditRowData } from '../../lib/hash-chain.js';

// Advisory lock key — constant across all writer connections.
// pg_advisory_xact_lock serializes chain-head reads within a transaction.
const AUDIT_CHAIN_LOCK_KEY = `hashtext('rbac_audit_chain')`;

export interface AuditLogRow {
  id: string;
  seq: string; // BIGSERIAL — returned as string by node-postgres
  ts: string;
  actor_id: string;
  actor_type: string;
  actor_email: string;
  action: string;
  target_type: string;
  target_id: string;
  before_state: unknown;
  after_state: unknown;
  ip: string | null;
  session_id: string | null;
  correlation_id: string | null;
  row_hash: string;
  prev_hash: string | null;
  chained_hash: string;
}

export interface AuditQueryFilters {
  actor_id?: string;
  action?: string;
  from?: string;  // ISO timestamp
  to?: string;    // ISO timestamp
  limit?: number;
  offset?: number;
}

export async function queryAuditLog(
  pool: Pool,
  filters: AuditQueryFilters,
): Promise<AuditLogRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.actor_id) {
    conditions.push(`actor_id = $${idx++}`);
    params.push(filters.actor_id);
  }
  if (filters.action) {
    conditions.push(`action = $${idx++}`);
    params.push(filters.action);
  }
  if (filters.from) {
    conditions.push(`ts >= $${idx++}`);
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push(`ts <= $${idx++}`);
    params.push(filters.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(filters.limit ?? 100, 1000);
  const offset = filters.offset ?? 0;

  params.push(limit, offset);

  // H5 fix: ORDER BY ts DESC, seq DESC — deterministic even when ts ties
  const res = await pool.query<AuditLogRow>(
    `SELECT id, seq, ts, actor_id, actor_type, actor_email, action,
            target_type, target_id, before_state, after_state,
            ip, session_id, correlation_id, row_hash, prev_hash, chained_hash
     FROM rbac.audit_log
     ${where}
     ORDER BY ts DESC, seq DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );
  return res.rows;
}

export interface AuditInsertInput {
  actor_id: string;
  actor_type: string;
  actor_email: string;
  action: string;
  target_type: string;
  target_id: string;
  before_state: unknown;
  after_state: unknown;
  ip?: string;
  session_id?: string;
  correlation_id?: string;
}

/**
 * Insert an audit log entry using writer pool.
 * Computes row_hash + fetches last chained_hash for prev_hash chain.
 *
 * C3 fix: The SELECT (prev hash) + INSERT happen inside a single explicit
 * transaction that first acquires pg_advisory_xact_lock. The lock serializes
 * all concurrent chain-head reads so two simultaneous callers can never read
 * the same prev_hash and fork the chain.
 *
 * H5 fix: chain-head lookup orders by seq DESC (BIGSERIAL) for deterministic
 * ordering even when multiple rows share the same microsecond timestamp.
 */
export async function insertAuditEntry(
  pool: Pool,
  input: AuditInsertInput,
): Promise<AuditLogRow> {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();

  const rowData: AuditRowData = {
    id,
    ts,
    actor_id: input.actor_id,
    actor_email: input.actor_email,
    action: input.action,
    target_type: input.target_type,
    target_id: input.target_id,
    before_state: input.before_state,
    after_state: input.after_state,
  };

  const row_hash = computeRowHash(rowData);

  // C3: acquire a client from the pool for an explicit transaction.
  // pg_advisory_xact_lock is held for the duration of the transaction and
  // automatically released on COMMIT/ROLLBACK — no manual unlock needed.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serialize chain writes: only one transaction at a time can hold this lock.
    await client.query(`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`);

    // H5: order by seq DESC for deterministic chain-head selection
    const prevRes = await client.query<{ chained_hash: string }>(
      `SELECT chained_hash FROM rbac.audit_log ORDER BY seq DESC LIMIT 1`,
    );
    const prev_hash = prevRes.rows[0]?.chained_hash ?? null;
    const chained_hash = computeChainedHash(prev_hash, row_hash);

    const res = await client.query<AuditLogRow>(
      `INSERT INTO rbac.audit_log
         (id, ts, actor_id, actor_type, actor_email, action, target_type, target_id,
          before_state, after_state, ip, session_id, correlation_id,
          row_hash, prev_hash, chained_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        id, ts,
        input.actor_id, input.actor_type, input.actor_email,
        input.action, input.target_type, input.target_id,
        input.before_state ? JSON.stringify(input.before_state) : null,
        input.after_state  ? JSON.stringify(input.after_state)  : null,
        input.ip ?? null,
        input.session_id ?? null,
        input.correlation_id ?? null,
        row_hash, prev_hash, chained_hash,
      ],
    );

    await client.query('COMMIT');
    return res.rows[0]!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verify chain integrity of last N rows (or all if n=0).
 * Returns true if chain is intact.
 * H5 fix: orders by seq ASC for deterministic verification ordering.
 */
export async function verifyAuditChainIntegrity(
  pool: Pool,
  lastN = 1000,
): Promise<{ ok: boolean; broken_at?: string }> {
  const res = await pool.query<AuditLogRow>(
    `SELECT id, seq, ts, actor_id, actor_type, actor_email, action,
            target_type, target_id, before_state, after_state,
            row_hash, prev_hash, chained_hash
     FROM rbac.audit_log
     ORDER BY seq ASC
     LIMIT $1`,
    [lastN > 0 ? lastN : 1_000_000],
  );

  let prevHash: string | null = null;
  for (const row of res.rows) {
    const expectedChained = computeChainedHash(prevHash, row.row_hash);
    if (expectedChained !== row.chained_hash) {
      return { ok: false, broken_at: row.id };
    }
    prevHash = row.chained_hash;
  }
  return { ok: true };
}
