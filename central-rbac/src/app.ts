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
import { webhookPreTokenRoutes } from './routes/webhook-pre-token.js';
import { assignmentRoutes } from './routes/assignments.js';
import { driftRoutes } from './routes/drift.js';
import { permissionsLookupRoutes } from './routes/permissions-lookup.js';
import { outboxAdminRoutes } from './routes/outbox-admin.js';
import { userRoutes } from './routes/users.js';
import { projectRoutes } from './routes/projects.js';
import { adminAppsRoutes } from './routes/admin-apps.js';
import { adminAppsSyncManifestRoutes } from './routes/admin-apps-sync-manifest.js';
import { wellKnownManifestSchemaRoutes } from './routes/well-known-manifest-schema.js';
import { auditorPool } from './db/auditor-pool.js';
import { writerPool } from './db/writer-pool.js';
import { verifyAuditChainIntegrity } from './db/queries/audit.js';
import { validateBreakGlassConfig } from './lib/break-glass.js';
import { startOutboxWorker, stopOutboxWorker } from './services/outbox-worker.js';
import { startOrphanCleanupWorker, stopOrphanCleanupWorker } from './workers/orphan-cleanup-worker.js';
import { redis } from './lib/redis-client.js';

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

  // Phase 06 mTLS global preHandler (Red Team Fix #3) — DISABLED by default.
  // Enable with MTLS_GLOBAL_ENFORCE=true after signer sidecar + Traefik chain deployed.
  // Explicit opt-outs: /webhooks/pre-token (Zitadel HMAC), /health, /ready, /.well-known/*.
  if (process.env['MTLS_GLOBAL_ENFORCE'] === 'true') {
    const { verifyMtls, verifyCertJwtCrosscheck } = await import('./middleware/auth-mtls.js');
    const { verifyJwt } = await import('./middleware/auth-jwt.js');
    const OPT_OUT_PREFIXES = ['/v1/webhooks/pre-token', '/health', '/ready', '/.well-known/'];
    app.addHook('preHandler', async (req, reply) => {
      if (OPT_OUT_PREFIXES.some((p) => req.url.startsWith(p))) return;
      await verifyMtls(req, reply);
      if (reply.sent) return;
      await verifyJwt(req, reply);
      if (reply.sent) return;
      await verifyCertJwtCrosscheck(req, reply);
    });
    logger.info('mTLS global enforcement ENABLED — cert-header-signer + Traefik chain must be live');
  }

  // Register all route plugins
  await app.register(healthRoutes);
  await app.register(permissionRoutes);
  await app.register(roleRoutes);
  await app.register(resolveRoutes);
  await app.register(auditRoutes);
  await app.register(webhookEchoRoutes);
  await app.register(webhookPreTokenRoutes);

  // Phase 3 routes
  await app.register(assignmentRoutes);
  await app.register(driftRoutes);
  await app.register(permissionsLookupRoutes);
  await app.register(outboxAdminRoutes);

  // Phase 5 routes — UI proxy endpoints
  await app.register(userRoutes);
  await app.register(projectRoutes);

  // Phase 07 routes — admin single-pane wizard
  await app.register(adminAppsRoutes);

  // Phase 08 routes — app self-registration (manifest sync + apply)
  await app.register(adminAppsSyncManifestRoutes);
  await app.register(wellKnownManifestSchemaRoutes);

  return app;
}

async function main() {
  // Validate break-glass config before binding port — fail fast on bad config
  validateBreakGlassConfig();

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

  // Start outbox worker after server is bound (OUTBOX_WORKER_ENABLED=true by default)
  startOutboxWorker();

  // Phase 07: start orphan-project cleanup worker (Zitadel rollback retry queue)
  startOrphanCleanupWorker();

  // H3 fix: graceful shutdown on SIGTERM (docker stop) and SIGINT (ctrl-c / compose down).
  // Drains the outbox worker, closes DB pools and Redis before exiting.
  // Any events still 'processing' at timeout are recovered by H2 stalled-row reaper on next boot.
  const gracefulShutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown: signal received, draining worker');
    try {
      stopOrphanCleanupWorker();
      await stopOutboxWorker(15_000); // grace 15s to finish current batch
      await app.close();
      await redis.quit().catch(() => {});
      await writerPool.end().catch(() => {});
      await auditorPool.end().catch(() => {});
      logger.info({ signal }, 'shutdown: complete');
    } catch (err) {
      logger.error({ err, signal }, 'shutdown: error during drain');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
  process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
}

// Only run main() when this file is executed directly (not imported in tests)
if (process.argv[1]?.endsWith('app.ts') || process.argv[1]?.endsWith('app.js')) {
  main();
}
