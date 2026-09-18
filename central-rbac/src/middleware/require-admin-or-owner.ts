/**
 * require-admin-or-owner.ts — Ownership-based authz middleware.
 *
 * Plan: 260918-0822-central-rbac-ownership-authz Phase 02.
 *
 * Ownership model: single owner per app (rbac.apps.created_by = jwt.sub).
 * Roles inherit owner via role.app_id → app.created_by.
 * Permissions inherit owner via naming prefix ({owner_slug}.*).
 *
 * Exports:
 *   - requireMember: basic gate — rbac.admin OR rbac.member OR system.root
 *   - requireAdminOrAppOwner(paramName): app-level ownership check
 *   - requireAdminOrRoleOwner(paramName): role.app_id ownership check
 *   - requireAdminOrPermOwner(paramName): permission key prefix ownership check
 *   - listOwnedAppsWhere(request): SQL WHERE fragment for list queries
 *   - isAdmin(request): helper — check admin role, useful for inline body checks
 *
 * All must run AFTER verifyJwt (reads request.jwtClaims).
 */
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { writerPool } from '../db/writer-pool.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { emitBreakGlassBypass } from '../lib/break-glass.js';

const ADMIN_ROLES = new Set(['rbac.admin', 'system.root']);
const MEMBER_ROLE = 'rbac.member';

/** True if JWT carries admin role (rbac.admin or system.root). */
export function isAdmin(request: FastifyRequest): boolean {
  const roles = request.jwtClaims?.roles ?? [];
  return roles.some((r) => ADMIN_ROLES.has(r));
}

/** True if JWT sub matches BREAK_GLASS_USER_ID env. */
export function isBreakGlass(request: FastifyRequest): boolean {
  const sub = request.jwtClaims?.sub;
  return !!(config.BREAK_GLASS_USER_ID && sub && sub === config.BREAK_GLASS_USER_ID);
}

/**
 * Break-glass bypass with audit. Returns true if request is break-glass; caller
 * should short-circuit authz check. Emits [BREAK-GLASS-USED] log for VL alert.
 * Use in place of bare `isBreakGlass(request)` in ownership check paths.
 */
export function bypassAndAudit(request: FastifyRequest): boolean {
  if (!isBreakGlass(request)) return false;
  emitBreakGlassBypass(
    request.jwtClaims?.sub ?? 'unknown',
    request.id,
    request.method,
    request.url,
  );
  return true;
}

/**
 * Basic gate — allow admin OR member OR break-glass.
 * Applied cho tất cả routes (read + write). Zitadel projectRoleCheck reject
 * user không có role → chỉ admin/member login được. 2-tier model sau khi
 * drop rbac.viewer (plan 260918-1308 Phase 01).
 */
export async function requireMember(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const claims = request.jwtClaims;
  if (!claims) {
    return reply.status(401).send({ error: 'Not authenticated' });
  }
  if (bypassAndAudit(request) || isAdmin(request)) return;

  const roles = Array.isArray(claims.roles) ? claims.roles : [];
  if (!roles.includes(MEMBER_ROLE)) {
    logger.warn(
      { sub: claims.sub, path: request.url, roles },
      'require-member: rejected (missing rbac.admin/rbac.member)',
    );
    return reply.status(403).send({ error: 'Forbidden — rbac.member or rbac.admin required' });
  }
}

/**
 * Factory: require caller to be admin OR owner of the app in URL params.
 * `paramName` = 'slug' (default) or 'id' — looks up apps.slug or apps.id.
 */
export function requireAdminOrAppOwner(
  paramName: 'slug' | 'id' = 'slug',
): preHandlerHookHandler {
  return async (request, reply) => {
    if (bypassAndAudit(request) || isAdmin(request)) return;

    const params = request.params as Record<string, string>;
    const paramValue = params[paramName];
    if (!paramValue) {
      return reply.status(400).send({ error: `Missing param ${paramName}` });
    }

    const column = paramName === 'slug' ? 'slug' : 'id';
    const { rows } = await writerPool.query<{ created_by: string }>(
      `SELECT created_by FROM rbac.apps WHERE ${column} = $1`,
      [paramValue],
    );
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'App not found' });
    }

    const sub = request.jwtClaims?.sub;
    if (rows[0].created_by !== sub) {
      logger.warn(
        { sub, app_owner: rows[0].created_by, path: request.url },
        'require-admin-or-app-owner: rejected',
      );
      return reply.status(403).send({ error: 'Forbidden — not app owner' });
    }
  };
}

/**
 * Factory: require caller to be admin OR owner of the role.
 * Role ownership = role.app_id → apps.created_by.
 * Legacy roles (app_id NULL, e.g. system.root, rbac.admin) → admin-only.
 */
export function requireAdminOrRoleOwner(
  paramName: 'key' = 'key',
): preHandlerHookHandler {
  return async (request, reply) => {
    if (bypassAndAudit(request) || isAdmin(request)) return;

    const params = request.params as Record<string, string>;
    const roleKey = params[paramName];
    if (!roleKey) {
      return reply.status(400).send({ error: `Missing param ${paramName}` });
    }

    const { rows } = await writerPool.query<{
      created_by: string | null;
      app_id: string | null;
    }>(
      `SELECT a.created_by, r.app_id
         FROM rbac.roles r
         LEFT JOIN rbac.apps a ON a.id = r.app_id
        WHERE r.key = $1`,
      [roleKey],
    );
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Role not found' });
    }
    const { created_by, app_id } = rows[0];

    // Legacy role (app_id NULL) → admin only
    if (!app_id || !created_by) {
      logger.warn(
        { sub: request.jwtClaims?.sub, roleKey, path: request.url },
        'require-admin-or-role-owner: legacy role, admin-only',
      );
      return reply.status(403).send({ error: 'Forbidden — legacy role, admin only' });
    }

    const sub = request.jwtClaims?.sub;
    if (created_by !== sub) {
      logger.warn(
        { sub, role_owner: created_by, roleKey },
        'require-admin-or-role-owner: rejected',
      );
      return reply.status(403).send({ error: 'Forbidden — not role owner' });
    }
  };
}

/**
 * Factory: require caller to be admin OR owner of the app matching permission
 * key prefix. Permission key format: `{app_slug}.{name}` (e.g. `myapp.foo.bar`).
 * If prefix doesn't match any app → admin-only (system permissions).
 */
export function requireAdminOrPermOwner(
  paramName: 'key' = 'key',
): preHandlerHookHandler {
  return async (request, reply) => {
    if (bypassAndAudit(request) || isAdmin(request)) return;

    const params = request.params as Record<string, string>;
    const permKey = params[paramName];
    if (!permKey) {
      return reply.status(400).send({ error: `Missing param ${paramName}` });
    }

    const prefix = permKey.split('.')[0];
    if (!prefix) {
      return reply.status(400).send({ error: 'Invalid permission key' });
    }

    const { rows } = await writerPool.query<{ created_by: string }>(
      `SELECT created_by FROM rbac.apps WHERE slug = $1`,
      [prefix],
    );
    if (rows.length === 0) {
      // Permission key không match app nào (VD system.*) → admin only
      logger.warn(
        { sub: request.jwtClaims?.sub, permKey, prefix },
        'require-admin-or-perm-owner: no matching app, admin-only',
      );
      return reply
        .status(403)
        .send({ error: 'Forbidden — permission not owned by any app, admin only' });
    }

    const sub = request.jwtClaims?.sub;
    if (rows[0].created_by !== sub) {
      logger.warn(
        { sub, app_owner: rows[0].created_by, permKey },
        'require-admin-or-perm-owner: rejected',
      );
      return reply.status(403).send({ error: 'Forbidden — not app owner for this permission' });
    }
  };
}

/**
 * Helper for list queries: return SQL WHERE fragment + params.
 * Admin/break-glass → `TRUE` (all rows).
 * Member → `created_by = $N` (own rows only).
 * No sub → `FALSE` (fail-close).
 *
 * @param request Fastify request with jwtClaims set
 * @param paramOffset Number of existing SQL params; caller must add returned params after this index
 */
export function listOwnedAppsWhere(
  request: FastifyRequest,
  paramOffset: number = 0,
): { where: string; params: string[] } {
  if (bypassAndAudit(request) || isAdmin(request)) {
    return { where: 'TRUE', params: [] };
  }
  const sub = request.jwtClaims?.sub;
  if (!sub) {
    return { where: 'FALSE', params: [] };
  }
  return { where: `created_by = $${paramOffset + 1}`, params: [sub] };
}
