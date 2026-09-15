/**
 * adapters/express-middleware.ts — Express-compat middleware factory.
 *
 * Usage:
 *   const rbac = new CentralRbacClient({...});
 *   app.get('/tickets',
 *     requirePermission(rbac, 'helpdesk:tickets.read', { tenantIdFrom: 'query.dept' }),
 *     handler);
 *
 * User_sub extraction: reads từ `req.user.sub` (typical Passport pattern) hoặc `req.jwtClaims.sub`.
 * Wraps async errors với try/catch → next(err) cho Express 4 compat.
 */
import type { CentralRbacClient } from '../client.js';
import { extractTenantId } from '../util/extract-tenant-id.js';
import { CentralRbacError } from '../errors.js';

/** Minimal Express-like types (avoid Express dep for tree-shaking). */
interface ReqLike {
  user?: { sub?: string; [k: string]: unknown };
  jwtClaims?: { sub?: string; [k: string]: unknown };
  [k: string]: unknown;
}
interface ResLike {
  status: (code: number) => ResLike;
  json: (body: unknown) => unknown;
}
type NextLike = (err?: unknown) => void;

function extractUserSub(req: ReqLike): string | null {
  const user = req.user;
  if (user?.sub && typeof user.sub === 'string') return user.sub;
  const claims = req.jwtClaims;
  if (claims?.sub && typeof claims.sub === 'string') return claims.sub;
  return null;
}

export function requirePermission(
  client: CentralRbacClient,
  permissionKey: string,
  opts?: { tenantIdFrom?: string },
): (req: ReqLike, res: ResLike, next: NextLike) => Promise<void> {
  return async (req: ReqLike, res: ResLike, next: NextLike): Promise<void> => {
    try {
      const userSub = extractUserSub(req);
      if (!userSub) {
        res.status(401).json({ error: 'Unauthorized — missing user_sub in request context' });
        return;
      }

      const tenantId = opts?.tenantIdFrom ? extractTenantId(req, opts.tenantIdFrom) : null;

      const check = await client.checkPermission(userSub, permissionKey, tenantId);
      if (!check.granted) {
        res.status(403).json({
          error: 'Forbidden',
          permission: permissionKey,
          reason: check.reason,
        });
        return;
      }

      next();
    } catch (err) {
      if (err instanceof CentralRbacError) {
        res.status(503).json({
          error: 'Service Unavailable',
          detail: 'Central RBAC unreachable — request rejected (failMode=closed)',
          code: err.code,
        });
        return;
      }
      next(err);
    }
  };
}
