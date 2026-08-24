/**
 * error-handler.ts — Global Fastify error handler.
 * Maps Zod validation errors and known app errors to clean HTTP responses.
 * Never leaks stack traces in production.
 */
import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // Zod validation errors → 400
  if (error.cause instanceof ZodError) {
    void reply.status(400).send({
      error: 'Validation error',
      details: error.cause.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  // Fastify validation errors (JSON schema) → 400
  if (error.statusCode === 400 && error.validation) {
    void reply.status(400).send({ error: 'Bad request', details: error.validation });
    return;
  }

  // Known HTTP errors pass through with their status
  if (error.statusCode && error.statusCode < 500) {
    void reply.status(error.statusCode).send({ error: error.message });
    return;
  }

  // Unexpected errors → 500, logged with full detail
  logger.error({ err: error, reqId: request.id, url: request.url }, 'unhandled error');
  const isProd = process.env['NODE_ENV'] === 'production';
  void reply.status(500).send({
    error: 'Internal server error',
    ...(isProd ? {} : { detail: error.message }),
  });
}
