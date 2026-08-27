/**
 * outbox-event-dispatcher.ts — Single-event dispatch + outcome classification.
 *
 * Called by the outbox worker loop for each claimed event. Handles:
 *   - SA anomaly detection (non-whitelisted operation → dead immediately)
 *   - Dispatch to per-operation handler (outbox-processor.ts)
 *   - HTTP error classification: 4xx → dead, 5xx/network → retry
 *
 * Outcome is returned as a discriminated literal for the caller to act on via markDone/markFailed/markDead.
 *
 * SA monitoring (S2 gate 2026-08-25): every dispatch is logged with operation tag.
 * Non-whitelisted operations emit [SA-ANOMALY] alert.
 */
import {
  addProjectRole,
  removeProjectRole,
  addUserGrant,
  updateUserGrant,
  removeUserGrant,
  addOrUpdateUserGrant,
} from './outbox-processor.js';
import { type OutboxEvent, type OutboxOperation } from '../db/queries/outbox.js';
import { redis } from '../lib/redis-client.js';
import { logger } from '../lib/logger.js';

/**
 * Ops that mutate a user's grants — after success, bust the user-detail + assignments
 * caches so the drawer refetch (see routes/assignments.ts scheduled polling) sees fresh
 * Zitadel state. Without this, refetch caches stale grants for 60s.
 */
const USER_GRANT_OPS: Set<OutboxOperation> = new Set([
  'add_user_grant',
  'update_user_grant',
  'remove_user_grant',
  'add_or_update_user_grant',
]);

async function bustUserCachesFromArgs(
  operation: OutboxOperation,
  args: Record<string, unknown>,
): Promise<void> {
  if (!USER_GRANT_OPS.has(operation)) return;
  const userId = args['userId'];
  if (typeof userId !== 'string' || userId.length === 0) return;
  await Promise.all([
    redis.del(`user-detail:v1:${userId}`).catch(() => {}),
    redis.del(`assignments:v1:${userId}`).catch(() => {}),
  ]);
}

const MAX_ATTEMPTS = 5;

// Whitelisted operations — anything else triggers [SA-ANOMALY]
export const ALLOWED_OPERATIONS: Set<OutboxOperation> = new Set([
  'add_project_role',
  'remove_project_role',
  'add_user_grant',
  'update_user_grant',
  'remove_user_grant',
  'add_or_update_user_grant', // H1+H4: enqueue-first assign path (worker decides add vs update)
]);

export type EventOutcome = 'done' | 'failed' | 'dead';

/**
 * Process a single outbox event — SA guard + dispatch + error classification.
 * Returns the outcome for the caller to persist via markDone/markFailed/markDead.
 */
export async function processEvent(event: OutboxEvent): Promise<EventOutcome> {
  const { id, operation, args, attempts } = event;

  // SA anomaly detection: non-whitelisted op triggers alert and immediate dead-letter
  if (!ALLOWED_OPERATIONS.has(operation as OutboxOperation)) {
    logger.error(
      { eventId: id, operation },
      '[SA-ANOMALY] outbox-dispatcher: unknown operation — marking dead immediately',
    );
    return 'dead';
  }

  logger.info(
    { eventId: id, operation, correlationId: event.correlation_id },
    'outbox-dispatcher: dispatching',
  );

  try {
    await dispatch(operation as OutboxOperation, args);
    // Bust user-detail cache AFTER Zitadel commit so next drawer refetch sees fresh state
    await bustUserCachesFromArgs(operation as OutboxOperation, args);
    return 'done';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    // Parse HTTP status from error message (convention: "... HTTP NNN")
    const statusMatch = /HTTP (\d{3})/.exec(msg);
    const httpStatus = statusMatch ? parseInt(statusMatch[1]!, 10) : 0;

    // 4xx (except 404/409 handled as success in processor) = data problem → dead immediately
    if (httpStatus >= 400 && httpStatus < 500) {
      logger.error(
        { eventId: id, operation, httpStatus, err: msg },
        'outbox-dispatcher: 4xx error — marking dead (no retry)',
      );
      return 'dead';
    }

    // 5xx / network error / timeout → retry up to MAX_ATTEMPTS
    const newAttempts = attempts + 1;
    if (newAttempts >= MAX_ATTEMPTS) {
      logger.error(
        { eventId: id, operation, attempts: newAttempts },
        '[OUTBOX-DEAD] outbox-dispatcher: max retries reached — marking dead',
      );
      return 'dead';
    }

    logger.warn(
      { eventId: id, operation, err: msg, attempt: newAttempts },
      'outbox-dispatcher: transient error — will retry',
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
    case 'add_or_update_user_grant':
      // H1+H4: advisory-locked read-modify-write in worker (no hot-path Zitadel call)
      await addOrUpdateUserGrant(args);
      break;
  }
}
