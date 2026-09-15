/**
 * adapters/fastify-plugin.ts — Fastify plugin encapsulate CentralRbacClient.
 *
 * Usage:
 *   await app.register(centralRbacFastify, { centralUrl, appSlug, centralRbacToken });
 *   app.get('/tickets', { preHandler: app.rbac.requirePermission('helpdesk:tickets.read') }, handler);
 *
 * User_sub extraction: reads từ `request.jwtClaims.sub` (set by @fastify/jwt hoặc auth plugin).
 * Fallback to `request.user.sub`. Throw 401 nếu không tìm thấy.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { CentralRbacClient } from '../client.js';
import type { CentralRbacClientConfig } from '../types.js';
import { extractTenantId } from '../util/extract-tenant-id.js';
import { CentralRbacError } from '../errors.js';

export interface FastifyRbacDecorator {
  client: CentralRbacClient;
  requirePermission(permissionKey: string, opts?: { tenantIdFrom?: string }): preHandlerHookHandler;
}

declare module 'fastify' {
  interface FastifyInstance {
    rbac: FastifyRbacDecorator;
  }
  interface FastifyRequest {
    // Set bởi upstream auth plugin — SDK không verify JWT, chỉ đọc.
    jwtClaims?: { sub?: string; [k: string]: unknown };
    user?: { sub?: string; [k: string]: unknown };
  }
}

function extractUserSub(request: FastifyRequest): string | null {
  const claims = request.jwtClaims;
  if (claims?.sub && typeof claims.sub === 'string') return claims.sub;
  const user = request.user;
  if (user?.sub && typeof user.sub === 'string') return user.sub;
  return null;
}

export const centralRbacFastify: FastifyPluginAsync<CentralRbacClientConfig> = async (
  app: FastifyInstance,
  opts: CentralRbacClientConfig,
): Promise<void> => {
  if (app.hasDecorator('rbac')) {
    throw new Error('centralRbacFastify: rbac decorator already registered — double registration?');
  }

  const client = new CentralRbacClient(opts);

  const decorator: FastifyRbacDecorator = {
    client,
    requirePermission(permissionKey, permOpts) {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        const userSub = extractUserSub(request);
        if (!userSub) {
          reply.status(401).send({ error: 'Unauthorized — missing user_sub in request context' });
          return;
        }

        const tenantId = permOpts?.tenantIdFrom ? extractTenantId(request, permOpts.tenantIdFrom) : null;

        try {
          const check = await client.checkPermission(userSub, permissionKey, tenantId);
          if (!check.granted) {
            reply.status(403).send({
              error: 'Forbidden',
              permission: permissionKey,
              reason: check.reason,
            });
            return;
          }
        } catch (err) {
          if (err instanceof CentralRbacError) {
            request.log.warn({ err, permissionKey, userSub }, 'central-rbac-fastify: check failed');
            reply.status(503).send({
              error: 'Service Unavailable',
              detail: 'Central RBAC unreachable — request rejected (failMode=closed)',
              code: err.code,
            });
            return;
          }
          throw err;
        }
      };
    },
  };

  app.decorate('rbac', decorator);
  app.addHook('onClose', async () => {
    client.close();
  });
};
