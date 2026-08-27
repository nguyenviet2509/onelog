/**
 * routes/metrics.ts — Prometheus scrape endpoint.
 *
 * GET /metrics — exposes registry contents in text/plain (Prometheus exposition
 * format). No JWT — see lib/metrics.ts for the network-scoping rationale.
 */
import type { FastifyInstance } from 'fastify';
import { registry } from '../lib/metrics.js';

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_request, reply) => {
    const body = await registry.metrics();
    return reply.type(registry.contentType).send(body);
  });
}
