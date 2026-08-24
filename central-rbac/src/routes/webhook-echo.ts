/**
 * routes/webhook-echo.ts — POST /v1/webhooks/pre-token/echo
 * Dev-only debug endpoint: echoes back the request body.
 * Disabled via WEBHOOK_ECHO_ENABLED=false (must be false in prod).
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export async function webhookEchoRoutes(app: FastifyInstance): Promise<void> {
  if (!config.WEBHOOK_ECHO_ENABLED) {
    logger.info('webhook-echo: disabled (WEBHOOK_ECHO_ENABLED=false)');
    return;
  }

  logger.warn('webhook-echo: ENABLED — disable before production deploy');

  app.post('/v1/webhooks/pre-token/echo', async (request, reply) => {
    return reply.send({
      echo: true,
      body: request.body,
      headers: {
        'zitadel-signature': request.headers['zitadel-signature'],
        'x-rbac-token': request.headers['x-rbac-token'] ? '[REDACTED]' : undefined,
        'content-type': request.headers['content-type'],
      },
      ts: new Date().toISOString(),
    });
  });
}
