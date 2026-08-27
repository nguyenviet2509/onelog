/**
 * routes/outbox-admin.ts — Admin debug view for outbox_events table.
 *
 * GET /v1/outbox?status=pending|failed|dead|done&limit=&offset= — list events
 * GET /v1/outbox/:id  — get single event
 * POST /v1/outbox/:id/retry — reset dead event to pending (manual retry)
 *
 * JWT auth required on all routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { writeAuditLog } from '../middleware/audit-log.js';
import {
  listOutboxEvents,
  getOutboxById,
  resetDeadToPending,
  type OutboxStatus,
} from '../db/queries/outbox.js';
import { writerPool } from '../db/writer-pool.js';
import { logger } from '../lib/logger.js';

const listQuerySchema = z.object({
  status: z.enum(['pending', 'processing', 'done', 'failed', 'dead']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const idParamSchema = z.object({ id: z.string().min(1) });

export async function outboxAdminRoutes(app: FastifyInstance): Promise<void> {
  // Outbox event args carry userIds/orgIds/roleKeys — gate to rbac.admin.
  const adminGate = { preHandler: [verifyJwt, requireAdmin] };

  // GET /v1/outbox — list events with optional status filter
  app.get('/v1/outbox', adminGate, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
    }

    const { status, limit, offset } = parsed.data;
    const events = await listOutboxEvents(writerPool, {
      status: status as OutboxStatus | undefined,
      limit,
      offset,
    });

    return reply.send({ data: events, count: events.length, limit, offset });
  });

  // GET /v1/outbox/:id — single event detail
  app.get('/v1/outbox/:id', adminGate, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'Invalid id' });
    }

    const event = await getOutboxById(writerPool, params.data.id);
    if (!event) return reply.status(404).send({ error: 'Outbox event not found' });
    return reply.send(event);
  });

  // POST /v1/outbox/:id/retry — reset dead event to pending
  app.post('/v1/outbox/:id/retry', adminGate, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'Invalid id' });
    }

    const id = params.data.id;
    let reset: boolean;
    try {
      reset = await resetDeadToPending(writerPool, id);
    } catch (err) {
      logger.error({ err, id }, 'outbox-admin: resetDeadToPending failed');
      return reply.status(500).send({ error: 'Failed to reset outbox event' });
    }

    if (!reset) {
      return reply.status(409).send({ error: 'Event not in dead status — cannot retry' });
    }

    await writeAuditLog(request, {
      action: 'outbox.retry',
      target_type: 'outbox_event',
      target_id: id,
      after_state: { status: 'pending', attempts: 0 },
    });

    logger.info({ id }, 'outbox-admin: event reset to pending');
    return reply.send({ status: 'reset', id });
  });
}
