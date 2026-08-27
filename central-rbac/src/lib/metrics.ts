/**
 * metrics.ts — Prometheus metrics registry.
 *
 * Registers default Node runtime metrics (event loop lag, GC, memory, CPU) and
 * app-specific counters. Exposed on GET /metrics (see routes/metrics.ts).
 *
 * Scrape from Prometheus / VictoriaMetrics on the private 10.200.0.0/24 net —
 * the /metrics route is not JWT-gated (Prometheus does not carry OIDC bearers),
 * so bind the port to an internal interface or restrict via Traefik middleware.
 */
import client from 'prom-client';

export const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry, prefix: 'rbac_' });

/** Outbox event dispatch outcomes — feeds alerting on dead-letter growth. */
export const outboxDispatchTotal = new client.Counter({
  name: 'rbac_outbox_dispatch_total',
  help: 'Outbox events processed by the dispatcher, labelled by operation and outcome',
  labelNames: ['operation', 'outcome'] as const,
  registers: [registry],
});
