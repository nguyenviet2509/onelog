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
 * Rate limiting: token bucket 30 ops/s (token-bucket.ts — no external dep).
 * Event dispatch + SA anomaly guard: outbox-event-dispatcher.ts.
 *
 * Start: call startOutboxWorker() on app boot.
 * Stop: call stopOutboxWorker(timeoutMs) on graceful shutdown (H3 fix).
 *
 * H2 fix: claimNextBatch recovers stalled 'processing' rows via visibility timeout.
 *         Recovered rows are logged at INFO as [OUTBOX-RECOVERED].
 */
import { writerPool } from '../db/writer-pool.js';
import {
  claimNextBatch,
  markDone,
  markFailed,
  markDead,
} from '../db/queries/outbox.js';
import { processEvent } from './outbox-event-dispatcher.js';
import { TokenBucket } from './token-bucket.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

// ── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_OPS_PER_SEC = 30;

// ── Worker state ──────────────────────────────────────────────────────────────

let running = false;
let workerPromise: Promise<void> | null = null;

// Resolves when the loop exits — used by stopOutboxWorker timeout race
let loopDoneResolve: (() => void) | null = null;

// ── Main loop ─────────────────────────────────────────────────────────────────

async function runLoop(): Promise<void> {
  const bucket = new TokenBucket(RATE_LIMIT_OPS_PER_SEC);
  logger.info('outbox-worker: started');

  while (running) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    if (!running) break;

    let events;
    try {
      events = await claimNextBatch(writerPool, BATCH_SIZE);
    } catch (err) {
      logger.error({ err }, 'outbox-worker: claimNextBatch failed — will retry next tick');
      continue;
    }

    if (events.length === 0) continue;

    // H2: log stalled rows recovered by visibility timeout in claimNextBatch
    const recovered = events.filter((e) => e.processing_started_at !== null);
    if (recovered.length > 0) {
      logger.info(
        { count: recovered.length, ids: recovered.map((e) => e.id) },
        '[OUTBOX-RECOVERED] outbox-worker: reclaimed stalled processing rows (worker crashed mid-batch)',
      );
    }

    logger.debug({ count: events.length }, 'outbox-worker: claimed batch');

    for (const event of events) {
      if (!running) break;

      // Rate limiting — wait until token is available
      const waitMs = bucket.waitMs();
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }

      // Dispatch: SA guard + Zitadel call + outcome classification
      const outcome = await processEvent(event);

      try {
        if (outcome === 'done') {
          await markDone(writerPool, event.id);
        } else if (outcome === 'failed') {
          const newAttempts = await markFailed(writerPool, event.id, 'transient error');
          // Promote to dead if markFailed pushed attempts over threshold
          if (newAttempts >= MAX_ATTEMPTS) {
            await markDead(writerPool, event.id, 'max attempts reached');
            logger.error(
              { eventId: event.id, operation: event.operation },
              '[OUTBOX-DEAD] outbox-worker: promoted to dead after markFailed',
            );
          }
        } else {
          await markDead(writerPool, event.id, 'permanent failure');
        }
      } catch (dbErr) {
        logger.error({ dbErr, eventId: event.id }, 'outbox-worker: DB mark failed — event may reprocess');
      }
    }
  }

  logger.info('outbox-worker: stopped');
  // Signal stopOutboxWorker timeout race that the loop has exited cleanly
  loopDoneResolve?.();
  loopDoneResolve = null;
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
    loopDoneResolve?.();
    loopDoneResolve = null;
  });
}

/**
 * Stop the worker gracefully (H3 fix — wired to SIGTERM/SIGINT in app.ts).
 * Signals the loop to stop and waits for the current batch to complete.
 * timeoutMs: max ms to wait; default 15000ms. After timeout, resolves anyway —
 * any in-flight 'processing' rows are recovered on next boot by H2 reaper.
 */
export async function stopOutboxWorker(timeoutMs = 15_000): Promise<void> {
  if (!running && !workerPromise) return;

  running = false;

  if (!workerPromise) return;

  // Race: loop exits naturally OR timeout fires
  const loopDone = new Promise<void>((resolve) => {
    loopDoneResolve = resolve;
  });
  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      logger.warn({ timeoutMs }, 'outbox-worker: stop timeout reached — proceeding with shutdown');
      resolve();
    }, timeoutMs),
  );

  await Promise.race([loopDone, timeout]);
  workerPromise = null;
}

/** Exposed for tests only — check if worker is running. */
export function isWorkerRunning(): boolean {
  return running;
}
