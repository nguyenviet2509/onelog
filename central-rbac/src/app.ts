/**
 * app.ts — Fastify application entry point.
 * Registers all plugins, routes, and error handler.
 * Verifies audit chain integrity on startup.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { healthRoutes } from './routes/health.js';
import { permissionRoutes } from './routes/permissions.js';
import { roleRoutes } from './routes/roles.js';
import { resolveRoutes } from './routes/resolve.js';
import { auditRoutes } from './routes/audit.js';
import { webhookEchoRoutes } from './routes/webhook-echo.js';
import { auditorPool } from './db/auditor-pool.js';
import { verifyAuditChainIntegrity } from './db/queries/audit.js';

// Extend FastifyRequest with rawBody for HMAC verification (C2 fix).
// rawBody is the exact bytes Zitadel signed — must verify BEFORE JSON.parse.
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildApp() {
  // trustProxy: real client IP behind Traefik/Caddy on 10.200.0.0/24 (H1 fix).
  // In dev, accept all proxy headers (true). In prod, restrict to internal subnet.
  const app = Fastify({
    logger: false, // Using pino directly via logger singleton
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',
    genReqId: () => crypto.randomUUID(),
    trustProxy: config.NODE_ENV === 'production' ? '10.200.0.0/24' : true,
  });

  // Security headers
  await app.register(helmet, { global: true });

  // CORS — read allowed origins from env (H2 fix).
  // CENTRAL_RBAC_CORS_ORIGIN: comma-separated allow-list or empty for no CORS in prod.
  const corsOrigins = config.CENTRAL_RBAC_CORS_ORIGIN
    ? config.CENTRAL_RBAC_CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
    : [];
  await app.register(cors, {
    origin: corsOrigins.length > 0
      ? corsOrigins
      : config.NODE_ENV === 'production' ? false : true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  // Raw body capture for HMAC verification (C2 fix).
  // Replaces default JSON content-type parser: stashes raw bytes on request.rawBody,
  // then parses normally. Zitadel signs the exact raw bytes — re-serializing parsed
  // JSON would change key order / whitespace and break HMAC verification.
  // The rawBody augmentation is declared above via `declare module 'fastify'`,
  // so _req already has rawBody in its type — no cast needed.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      // body type is Buffer when parseAs:'buffer' is set
      _req.rawBody = body as Buffer;
      try {
        const parsed: unknown = JSON.parse((body as Buffer).toString('utf8'));
        done(null, parsed);
      } catch (e) {
        done(e as Error, undefined);
      }
    },
  );

  // Global error handler
  app.setErrorHandler(errorHandler);

  // Register all route plugins
  await app.register(healthRoutes);
  await app.register(permissionRoutes);
  await app.register(roleRoutes);
  await app.register(resolveRoutes);
  await app.register(auditRoutes);
  await app.register(webhookEchoRoutes);

  return app;
}

async function main() {
  const app = await buildApp();

  // Startup: verify audit chain integrity (alert if broken, don't block)
  try {
    const integrity = await verifyAuditChainIntegrity(auditorPool, 1000);
    if (!integrity.ok) {
      logger.error(
        { broken_at: integrity.broken_at },
        'STARTUP: audit chain integrity BROKEN — investigate immediately',
      );
    } else {
      logger.info('STARTUP: audit chain integrity OK');
    }
  } catch (err) {
    // DB may not be migrated yet on first boot — log and continue
    logger.warn({ err }, 'STARTUP: audit chain check skipped (DB may not be ready)');
  }

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info({ port: config.PORT }, 'central-rbac listening');
  } catch (err) {
    logger.fatal({ err }, 'failed to start server');
    process.exit(1);
  }
}

// Only run main() when this file is executed directly (not imported in tests)
if (process.argv[1]?.endsWith('app.ts') || process.argv[1]?.endsWith('app.js')) {
  main();
}
