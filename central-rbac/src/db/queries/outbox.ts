/**
 * queries/outbox.ts — CRUD helpers for rbac.outbox_events.
 * Used by outbox worker (claim/mark) and route handlers (enqueue).
 *
 * Operations:
 *   add_project_role    — POST /management/v1/projects/{id}/roles
 *   remove_project_role — DELETE /management/v1/projects/{id}/roles/{key}
 *   add_user_grant      — POST /management/v1/users/{id}/grants
 *   update_user_grant   — PUT /management/v1/users/{id}/grants/{grantId}
 *   remove_user_grant   — DELETE /management/v1/users/{id}/grants/{grantId}
 */
import type { Pool, PoolClient } from 'pg';

export type OutboxOperation =
  | 'add_project_role'
  | 'remove_project_role'
  | 'add_user_grant'
  | 'update_user_grant'
  | 'remove_user_grant'
  | 'add_or_update_user_grant';

export type OutboxStatus = 'pending' | 'processing' | 'done' | 'failed' | 'dead';

export interface OutboxEvent {
  id: string; // BIGSERIAL as string
  idempotency_key: string;
  operation: OutboxOperation;
  args: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  correlation_id: string | null;
  created_at: string;
  processed_at: string | null;
  last_error: string | null;
  processing_started_at: string | null; // set when worker claims row; enables stalled-row recovery (H2)
}

export interface EnqueueResult {
  id: string;
  idempotency_key: string;
  /** true when a row was inserted; false when idempotency_key already existed */
  inserted: boolean;
}

/** Enqueue an outbox event inside an open transaction.
 *  ON CONFLICT on idempotency_key is a no-op — idempotent by design.
 */
export async function enqueueOutbox(
  tx: Pool | PoolClient,
  operation: OutboxOperation,
  args: Record<string, unknown>,
  idempotencyKey: string,
  correlationId?: string,
): Promise<EnqueueResult> {
  const res = await tx.query<{ id: string; idempotency_key: string }>(
    `INSERT INTO rbac.outbox_events (idempotency_key, operation, args, correlation_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, idempotency_key`,
    [idempotencyKey, operation, JSON.stringify(args), correlationId ?? null],
  );
  if (res.rows.length > 0) {
    return { id: res.rows[0]!.id, idempotency_key: res.rows[0]!.idempotency_key, inserted: true };
  }
  // Conflict — fetch existing row id for reference
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM rbac.outbox_events WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return {
    id: existing.rows[0]?.id ?? '0',
    idempotency_key: idempotencyKey,
    inserted: false,
  };
}

/**
 * Claim up to N pending/failed events (or stalled processing events) for processing.
 * Uses SELECT ... FOR UPDATE SKIP LOCKED — safe for concurrent workers.
 * Marks claimed rows as 'processing' and sets processing_started_at = NOW() atomically.
 *
 * H2 fix: rows where status='processing' AND processing_started_at < NOW()-5min
 * (worker crashed mid-batch) are treated as re-eligible — visibility timeout pattern.
 * Stalled rows recovered here are logged by the caller as [OUTBOX-RECOVERED].
 */
export async function claimNextBatch(pool: Pool, batchSize: number): Promise<OutboxEvent[]> {
  const MAX_ATTEMPTS = 5;
  const STALL_TIMEOUT_INTERVAL = '5 minutes';
  const res = await pool.query<OutboxEvent>(
    `UPDATE rbac.outbox_events
     SET status = 'processing', processing_started_at = NOW()
     WHERE id IN (
       SELECT id FROM rbac.outbox_events
       WHERE (
         (status IN ('pending', 'failed') AND attempts < $2)
         OR
         (status = 'processing' AND processing_started_at < NOW() - INTERVAL '${STALL_TIMEOUT_INTERVAL}')
       )
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, idempotency_key, operation, args, status, attempts,
               correlation_id, created_at, processed_at, last_error, processing_started_at`,
    [batchSize, MAX_ATTEMPTS],
  );
  return res.rows;
}

/** Mark event as successfully processed. */
export async function markDone(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE rbac.outbox_events
     SET status = 'done', processed_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

/**
 * Mark event as failed (retry-eligible).
 * Increments attempt counter. Caller decides if dead-letter threshold reached.
 */
export async function markFailed(pool: Pool, id: string, errorMsg: string): Promise<number> {
  const res = await pool.query<{ attempts: number }>(
    `UPDATE rbac.outbox_events
     SET status = 'failed',
         attempts = attempts + 1,
         last_error = $2
     WHERE id = $1
     RETURNING attempts`,
    [id, errorMsg.slice(0, 2000)],
  );
  return res.rows[0]?.attempts ?? 0;
}

/** Mark event as dead (permanently failed after max retries). Emit alert log. */
export async function markDead(pool: Pool, id: string, errorMsg: string): Promise<void> {
  await pool.query(
    `UPDATE rbac.outbox_events
     SET status = 'dead',
         attempts = attempts + 1,
         last_error = $2,
         processed_at = NOW()
     WHERE id = $1`,
    [id, errorMsg.slice(0, 2000)],
  );
}

/** Get a single event by id (admin debug). */
export async function getOutboxById(pool: Pool, id: string): Promise<OutboxEvent | null> {
  const res = await pool.query<OutboxEvent>(
    `SELECT id, idempotency_key, operation, args, status, attempts,
            correlation_id, created_at, processed_at, last_error, processing_started_at
     FROM rbac.outbox_events WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

export interface OutboxListFilter {
  status?: OutboxStatus;
  limit?: number;
  offset?: number;
}

/** List events for admin visibility (GET /v1/outbox). */
export async function listOutboxEvents(
  pool: Pool,
  filter: OutboxListFilter = {},
): Promise<OutboxEvent[]> {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = filter.offset ?? 0;

  if (filter.status) {
    const res = await pool.query<OutboxEvent>(
      `SELECT id, idempotency_key, operation, args, status, attempts,
              correlation_id, created_at, processed_at, last_error, processing_started_at
       FROM rbac.outbox_events
       WHERE status = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [filter.status, limit, offset],
    );
    return res.rows;
  }

  const res = await pool.query<OutboxEvent>(
    `SELECT id, idempotency_key, operation, args, status, attempts,
            correlation_id, created_at, processed_at, last_error, processing_started_at
     FROM rbac.outbox_events
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return res.rows;
}

/** Reset a dead event to pending (manual retry via admin API). */
export async function resetDeadToPending(pool: Pool, id: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE rbac.outbox_events
     SET status = 'pending', attempts = 0, last_error = NULL
     WHERE id = $1 AND status = 'dead'`,
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}
