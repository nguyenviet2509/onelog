/**
 * orphan-cleanup-worker.ts — Retry Zitadel RemoveProject for orphan projects.
 * Phase 07 Fix #8.
 *
 * Polls rbac.pending_cleanups WHERE next_retry_at < now() every POLL_INTERVAL_MS.
 * FOR UPDATE SKIP LOCKED prevents duplicate work if multiple instances run.
 * Exponential backoff: 60s → 5m → 30m → 2h → 6h. Give up after MAX_ATTEMPTS.
 */
import { writerPool } from '../db/writer-pool.js';
import { removeProject } from '../lib/zitadel-project-client.js';
import { logger } from '../lib/logger.js';

const POLL_INTERVAL_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
// Backoff schedule in seconds — indexed by attempt_count AFTER increment
const BACKOFF_SEC = [60, 300, 1800, 7200, 21600];

interface PendingRow {
  id: string;
  zitadel_project_id: string;
  project_name: string;
  admin_sub: string;
  attempt_count: number;
  last_error: string | null;
}

async function processOne(): Promise<boolean> {
  const client = await writerPool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<PendingRow>(
      `SELECT id, zitadel_project_id, project_name, admin_sub, attempt_count, last_error
         FROM rbac.pending_cleanups
        WHERE next_retry_at <= now()
        ORDER BY next_retry_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    const row = rows[0];
    if (!row) {
      await client.query('COMMIT');
      return false;
    }

    logger.info(
      { id: row.id, project_id: row.zitadel_project_id, attempt: row.attempt_count + 1 },
      'orphan-cleanup: retrying RemoveProject',
    );

    try {
      await removeProject(row.zitadel_project_id);
      await client.query(`DELETE FROM rbac.pending_cleanups WHERE id = $1`, [row.id]);
      await client.query('COMMIT');
      logger.info({ id: row.id, project_id: row.zitadel_project_id }, 'orphan-cleanup: success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const nextAttempt = row.attempt_count + 1;
      if (nextAttempt >= MAX_ATTEMPTS) {
        await client.query(`DELETE FROM rbac.pending_cleanups WHERE id = $1`, [row.id]);
        await client.query('COMMIT');
        logger.error(
          { id: row.id, project_id: row.zitadel_project_id, attempts: nextAttempt, error: msg },
          'orphan-cleanup: giving up after max attempts — manual cleanup needed',
        );
      } else {
        const backoff = BACKOFF_SEC[Math.min(nextAttempt - 1, BACKOFF_SEC.length - 1)] ?? 21600;
        await client.query(
          `UPDATE rbac.pending_cleanups
              SET attempt_count = $2,
                  last_error = $3,
                  next_retry_at = now() + make_interval(secs => $4)
            WHERE id = $1`,
          [row.id, nextAttempt, msg, backoff],
        );
        await client.query('COMMIT');
        logger.warn(
          { id: row.id, project_id: row.zitadel_project_id, attempt: nextAttempt, backoff_sec: backoff },
          'orphan-cleanup: retry scheduled',
        );
      }
    }
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'orphan-cleanup: transaction error');
    return false;
  } finally {
    client.release();
  }
}

let interval: NodeJS.Timeout | null = null;

/** Start the poll loop. Idempotent — safe to call twice. */
export function startOrphanCleanupWorker(): void {
  if (interval) return;
  logger.info({ interval_ms: POLL_INTERVAL_MS }, 'orphan-cleanup-worker: starting');
  interval = setInterval(() => {
    processOne().catch((err) => logger.error({ err }, 'orphan-cleanup: poll error'));
  }, POLL_INTERVAL_MS);
}

/** Stop the poll loop. */
export function stopOrphanCleanupWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    logger.info('orphan-cleanup-worker: stopped');
  }
}
