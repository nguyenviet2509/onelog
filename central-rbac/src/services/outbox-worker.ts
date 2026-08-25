/**
 * outbox-worker.ts — Background poll loop for processing rbac.outbox_events.
 *
 * Loop: sleep 1s → claimNextBatch(10) → dispatch each to Zitadel Mgmt API.
 *
 * Idempotency (S1 gate 2026-08-25):
 *   - 409 on add_project_role / add_user_grant → markDone (already exists = goal achieved)
 *   - 404 on remove_user_grant → markDone (already removed = goal achieved)
 *   - 200 idempotent on remove_project_role (Zitadel safe)
 *
 * Retry / dead-letter:
 *   - 5xx / timeout → markFailed (retry up to 5 attempts)
 *   - attempts >= 5 → markDead + emit [OUTBOX-DEAD] alert log
 *   - 4xx (except idempotency) → markDead immediately (no retry, data problem)
 *
 * Rate limiting: in-house token bucket — 30 ops/s (avoids p-throttle dep).
 *
 * Start: call startOutboxWorker() on app boot.
 * Stop: call stopOutboxWorker() on graceful shutdown.
 *
 * SA monitoring (S2 gate): every Zitadel call is logged with operation tag
 * for anomaly detection. Non-whitelisted operations emit [SA-ANOMALY] alert.
 */
import { writerPool } from '../db/writer-pool.js';
import {
  claimNextBatch,
  markDone,
  markFailed,
  markDead,
  type OutboxEvent,
  type OutboxOperation,
} from '../db/queries/outbox.js';
import {
  addProjectRole,
  removeProjectRole,
  addUserGrant,
  updateUserGrant,
  removeUserGrant,
} from './outbox-processor.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

// ── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_OPS_PER_SEC = 30;

// Whitelisted operations — anything else triggers [SA-ANOMALY]
const ALLOWED_OPERATIONS: Set<OutboxOperation> = new Set([
  'add_project_role',
  'remove_project_role',
  'add_user_grant',
  'update_user_grant',
  'remove_user_grant',
]);

// ── Token bucket rate limiter (30 ops/s) ─────────────────────────────────────

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly opsPerSec: number) {
    this.tokens = opsPerSec;
    this.lastRefill = Date.now();
  }

  /** Returns ms to wait before consuming a token; 0 = consume immediately. */
  waitMs(): number {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refill = Math.floor((elapsed / 1000) * this.opsPerSec);
    if (refill > 0) {
      this.tokens = Math.min(this.opsPerSec, this.tokens + refill);
      this.lastRefill = now;
    }
    if (this.tokens > 0) {
      this.tokens--;
      return 0;
    }
    // Calculate wait time until next token
    return Math.ceil(1000 / this.opsPerSec);
  }
}

// ── Worker state ──────────────────────────────────────────────────────────────

let running = false;
let workerPromise: Promise<void> | null = null;

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Process a single outbox event.
 * Returns 'done' | 'failed' | 'dead' to indicate outcome.
 */
async function processEvent(event: OutboxEvent): Promise<'done' | 'failed' | 'dead'> {
  const { id, operation, args, attempts } = event;

  // SA anomaly detection
  if (!ALLOWED_OPERATIONS.has(operation as OutboxOperation)) {
    logger.error(
      { eventId: id, operation },
      '[SA-ANOMALY] outbox-worker: unknown operation — marking dead immediately',
    );
    return 'dead';
  }

  logger.info(
    { eventId: id, operation, correlationId: event.correlation_id },
    'outbox-worker: dispatching',
  );

  try {
    // Dispatch to per-operation handler in outbox-processor.ts
    await dispatch(operation as OutboxOperation, args);
    return 'done';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    // Parse HTTP status from error message (convention: "... HTTP NNN")
    const statusMatch = /HTTP (\d{3})/.exec(msg);
    const httpStatus = statusMatch ? parseInt(statusMatch[1]!, 10) : 0;

    // 4xx (except 404/409 which are handled in processor as success) = data error → dead
    if (httpStatus >= 400 && httpStatus < 500) {
      logger.error(
        { eventId: id, operation, httpStatus, err: msg },
        'outbox-worker: 4xx error — marking dead (no retry)',
      );
      return 'dead';
    }

    // 5xx / network error / timeout → retry
    const newAttempts = attempts + 1;
    if (newAttempts >= MAX_ATTEMPTS) {
      logger.error(
        { eventId: id, operation, attempts: newAttempts },
        '[OUTBOX-DEAD] outbox-worker: max retries reached — marking dead',
      );
      return 'dead';
    }

    logger.warn(
      { eventId: id, operation, err: msg, attempt: newAttempts },
      'outbox-worker: transient error — will retry',
    );
    return 'failed';
  }
}

async function dispatch(
  operation: OutboxOperation,
  args: Record<string, unknown>,
): Promise<void> {
  switch (operation) {
    case 'add_project_role':
      await addProjectRole(args);
      break;
    case 'remove_project_role':
      await removeProjectRole(args);
      break;
    case 'add_user_grant':
      await addUserGrant(args);
      break;
    case 'update_user_grant':
      await updateUserGrant(args);
      break;
    case 'remove_user_grant':
      await removeUserGrant(args);
      break;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function runLoop(): Promise<void> {
  const bucket = new TokenBucket(RATE_LIMIT_OPS_PER_SEC);
  logger.info('outbox-worker: started');

  while (running) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    if (!running) break;

    let events: OutboxEvent[];
    try {
      events = await claimNextBatch(writerPool, BATCH_SIZE);
    } catch (err) {
      logger.error({ err }, 'outbox-worker: claimNextBatch failed — will retry next tick');
      continue;
    }

    if (events.length === 0) continue;

    logger.debug({ count: events.length }, 'outbox-worker: claimed batch');

    for (const event of events) {
      if (!running) break;

      // Rate limiting
      const waitMs = bucket.waitMs();
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }

      const outcome = await processEvent(event);

      try {
        if (outcome === 'done') {
          await markDone(writerPool, event.id);
        } else if (outcome === 'failed') {
          const newAttempts = await markFailed(writerPool, event.id, 'transient error');
          // Double-check dead threshold after markFailed increments counter
          if (newAttempts >= MAX_ATTEMPTS) {
            await markDead(writerPool, event.id, 'max attempts reached');
            logger.error(
              { eventId: event.id, operation: event.operation },
              '[OUTBOX-DEAD] outbox-worker: promoted to dead after markFailed',
            );
          }
        } else {
          // dead
          await markDead(writerPool, event.id, 'permanent failure');
        }
      } catch (dbErr) {
        logger.error({ dbErr, eventId: event.id }, 'outbox-worker: DB mark failed — event may reprocess');
      }
    }
  }

  logger.info('outbox-worker: stopped');
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Start the outbox worker background loop. Safe to call once on app boot. */
export function startOutboxWorker(): void {
  if (!config.OUTBOX_WORKER_ENABLED) {
    logger.info('outbox-worker: disabled by OUTBOX_WORKER_ENABLED=false');
    return;
  }
  if (running) {
    logger.warn('outbox-worker: already running — ignoring duplicate start');
    return;
  }
  running = true;
  workerPromise = runLoop().catch((err) => {
    logger.fatal({ err }, 'outbox-worker: unhandled error in loop');
    running = false;
  });
}

/** Stop the worker gracefully (waits for current batch to finish). */
export async function stopOutboxWorker(): Promise<void> {
  running = false;
  if (workerPromise) {
    await workerPromise;
    workerPromise = null;
  }
}

/** Exposed for tests only — check if worker is running. */
export function isWorkerRunning(): boolean {
  return running;
}
