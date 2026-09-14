/**
 * app.ts — Minimal Fastify template consuming @onelog/central-rbac-client.
 *
 * Demonstrates:
 *   - SDK registration via Fastify plugin
 *   - Route protection với requirePermission
 *   - Tenant-aware protection (tenantIdFrom query param)
 *   - Graceful shutdown (SDK epoch poller stopped)
 *
 * NOTE: This template assumes upstream auth plugin sets `request.jwtClaims.sub`.
 * Wire up @fastify/jwt or similar for real user_sub extraction from Zitadel JWT.
 */
import Fastify from 'fastify';
import { centralRbacFastify } from '@onelog/central-rbac-client/fastify';
import { config } from './config.js';
import { ticketRoutes } from './routes/tickets.js';

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: 'info' } });

  // ── Mock auth plugin — replace với real Zitadel JWT verify trong prod ──
  app.addHook('preHandler', async (request) => {
    // Demo: read x-user-sub header (dev only). Prod: verify Zitadel JWT.
    const sub = request.headers['x-user-sub'];
    if (typeof sub === 'string') {
      request.jwtClaims = { sub };
    }
  });

  // ── Register Central RBAC SDK ──
  await app.register(centralRbacFastify, {
    centralUrl: config.CENTRAL_URL,
    appSlug: config.APP_SLUG,
    centralRbacToken: config.CENTRAL_RBAC_TOKEN,
    logger: app.log,
    // failMode default 'closed' — safe for production (Central down → 503)
  });

  // ── Health endpoint (no auth) ──
  app.get('/health', async () => ({ status: 'ok', app: config.APP_SLUG }));

  // ── Business routes protected by RBAC ──
  await app.register(ticketRoutes);

  // ── Graceful shutdown ──
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutdown: stopping app');
    await app.close();  // triggers rbac.client.close() via SDK plugin onClose hook
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info({ port: config.PORT, appSlug: config.APP_SLUG }, 'template-app listening');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
