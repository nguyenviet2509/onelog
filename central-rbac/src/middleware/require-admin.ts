/**
 * require-admin.ts — Fastify preHandler that gates routes to rbac.admin role.
 *
 * Must run AFTER verifyJwt (reads request.jwtClaims.roles). Returns 403 if the
 * caller's JWT does not carry rbac.admin (or a break-glass override matches).
 *
 * Used on routes exposing sensitive operational data (outbox event args carry
 * userIds/orgIds/roleKeys — PII-adjacent) or destructive endpoints.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const ADMIN_ROLE = 'rbac.admin';

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const claims = request.jwtClaims;
  if (!claims) {
    return reply.status(401).send({ error: 'Not authenticated' });
  }

  // Break-glass: env-configured sub bypasses role check.
  if (config.BREAK_GLASS_USER_ID && claims.sub === config.BREAK_GLASS_USER_ID) {
    return;
  }

  const roles = Array.isArray(claims.roles) ? claims.roles : [];
  if (!roles.includes(ADMIN_ROLE)) {
    logger.warn(
      { sub: claims.sub, path: request.url, roles },
      'require-admin: rejected (missing rbac.admin)',
    );
    return reply.status(403).send({ error: 'Forbidden — rbac.admin role required' });
  }
}
