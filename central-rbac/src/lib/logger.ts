/**
 * logger.ts — Pino logger singleton.
 * Log level controlled by LOG_LEVEL env var.
 */
import pino from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
  base: { service: 'central-rbac' },
  // Redact sensitive fields from logs
  redact: ['req.headers.authorization', 'req.headers["x-rbac-token"]', 'req.headers["zitadel-signature"]'],
});
