/**
 * logger.ts — Pino logger singleton + shared options for Fastify HTTP access log.
 *
 * Two consumers:
 *   1. `logger` singleton — startup/shutdown/background workers (no request ctx).
 *   2. `fastifyLoggerOptions` — Fastify builds its own child pino via these options
 *      so per-request logs carry `reqId` and Fastify's built-in req/res auto-log.
 *
 * Per-request context (sub, user_email, session_id, user_id) is attached via
 * `request.log = request.log.child({...})` inside auth middleware / route handlers.
 * Fastify's onResponse "request completed" log inherits child bindings, so a single
 * grep by user_email/sub in VL surfaces the full request trace.
 */
import pino from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';

const level = process.env['LOG_LEVEL'] ?? 'info';

const redact = [
  'req.headers.authorization',
  'req.headers["x-rbac-token"]',
  'req.headers["zitadel-signature"]',
  'req.headers.cookie',
  'req.body.password',
  'req.body.secret',
  'req.body.token',
  'req.body.client_secret',
];

const transport = isDev
  ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
  : undefined;

export const logger = pino({
  level,
  transport,
  base: { service: 'central-rbac' },
  redact,
});

/**
 * Fastify uses this to build its own pino. Keep in sync with singleton config
 * (same base/redact/transport) so VL sees uniform shape from all sources.
 */
export const fastifyLoggerOptions = {
  level,
  transport,
  base: { service: 'central-rbac' },
  redact,
};
