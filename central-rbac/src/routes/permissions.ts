/**
 * routes/permissions.ts — CRUD for /v1/permissions.
 * key is immutable after creation (PATCH rejects key change).
 * All mutations write audit log.
 */
import type { FastifyInstance } from 'fastify';
import { verifyJwt } from '../middleware/auth-jwt.js';
import {
  isAdmin,
  requireMember,
  requireAdminOrPermOwner,
} from '../middleware/require-admin-or-owner.js';
import { writeAuditLog } from '../middleware/audit-log.js';
import { writerPool } from '../db/writer-pool.js';
import {
  listPermissions,
  getPermissionByKey,
  createPermission,
  updatePermission,
  deletePermission,
  getPermissionStats,
} from '../db/queries/permissions.js';
import {
  createPermissionSchema,
  updatePermissionSchema,
  permissionKeyParamSchema,
} from '../schemas/permission-schemas.js';

export async function permissionRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/permissions
  // Ownership scope: admin sees all; member sees only permissions with key prefix
  // matching owned app slug (e.g. member of app `foo` sees `foo.*`).
  app.get('/v1/permissions', { preHandler: [verifyJwt, requireMember] }, async (request, reply) => {
    if (isAdmin(request)) {
      const perms = await listPermissions(writerPool);
      return reply.send({ data: perms });
    }
    const sub = request.jwtClaims?.sub;
    const { rows } = await writerPool.query(
      `SELECT p.*
         FROM rbac.permissions p
        WHERE split_part(p.key, '.', 1) IN (
                SELECT slug FROM rbac.apps WHERE created_by = $1
              )
        ORDER BY p.key`,
      [sub],
    );
    return reply.send({ data: rows });
  });

  // GET /v1/permissions/:key
  app.get('/v1/permissions/:key', { preHandler: [verifyJwt, requireMember] }, async (request, reply) => {
    const p = permissionKeyParamSchema.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'Invalid key' });

    const perm = await getPermissionByKey(writerPool, p.data.key);
    if (!perm) return reply.status(404).send({ error: 'Permission not found' });
    return reply.send(perm);
  });

  // POST /v1/permissions
  app.post('/v1/permissions', { preHandler: [verifyJwt, requireMember] }, async (request, reply) => {
    const parsed = createPermissionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
    }

    // Ownership check: member may only create permissions with key prefix matching owned app slug.
    // Admin bypasses this check (can create system permissions).
    if (!isAdmin(request)) {
      const prefix = parsed.data.key.split('.')[0];
      if (!prefix) {
        return reply.status(400).send({ error: 'Invalid permission key format' });
      }
      const { rows: appRows } = await writerPool.query<{ created_by: string }>(
        `SELECT created_by FROM rbac.apps WHERE slug = $1`,
        [prefix],
      );
      if (appRows.length === 0) {
        return reply.status(403).send({
          error: `Forbidden — permission key prefix '${prefix}' must match an owned app slug`,
        });
      }
      if (appRows[0]!.created_by !== request.jwtClaims?.sub) {
        return reply.status(403).send({ error: 'Forbidden — not owner of app matching this permission prefix' });
      }
    }

    // Check key uniqueness
    const existing = await getPermissionByKey(writerPool, parsed.data.key);
    if (existing) return reply.status(409).send({ error: 'Permission key already exists' });

    const perm = await createPermission(writerPool, parsed.data);

    await writeAuditLog(request, {
      action: 'permission.create',
      target_type: 'permission',
      target_id: perm.key,
      after_state: perm,
    });

    return reply.status(201).send(perm);
  });

  // PATCH /v1/permissions/:key
  app.patch('/v1/permissions/:key', { preHandler: [verifyJwt, requireAdminOrPermOwner('key')] }, async (request, reply) => {
    const p = permissionKeyParamSchema.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'Invalid key param' });

    // Reject attempts to change the key (immutability enforcement)
    const body = request.body as Record<string, unknown>;
    if ('key' in body) {
      return reply.status(422).send({ error: 'Permission key is immutable and cannot be changed' });
    }

    const parsed = updatePermissionSchema.safeParse(body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
    }

    const before = await getPermissionByKey(writerPool, p.data.key);
    if (!before) return reply.status(404).send({ error: 'Permission not found' });

    const updated = await updatePermission(writerPool, p.data.key, parsed.data);
    if (!updated) return reply.status(404).send({ error: 'Permission not found' });

    await writeAuditLog(request, {
      action: 'permission.update',
      target_type: 'permission',
      target_id: p.data.key,
      before_state: before,
      after_state: updated,
    });

    return reply.send(updated);
  });

  // DELETE /v1/permissions/:key
  app.delete('/v1/permissions/:key', { preHandler: [verifyJwt, requireAdminOrPermOwner('key')] }, async (request, reply) => {
    const p = permissionKeyParamSchema.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'Invalid key' });

    const before = await getPermissionByKey(writerPool, p.data.key);
    if (!before) return reply.status(404).send({ error: 'Permission not found' });

    const deleted = await deletePermission(writerPool, p.data.key);
    if (!deleted) return reply.status(404).send({ error: 'Permission not found' });

    await writeAuditLog(request, {
      action: 'permission.delete',
      target_type: 'permission',
      target_id: p.data.key,
      before_state: before,
    });

    return reply.status(204).send();
  });

  // GET /v1/permissions/:key/stats
  app.get('/v1/permissions/:key/stats', { preHandler: [verifyJwt, requireMember] }, async (request, reply) => {
    const p = permissionKeyParamSchema.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'Invalid key' });

    const stats = await getPermissionStats(writerPool, p.data.key);
    if (!stats) return reply.status(404).send({ error: 'Permission not found' });
    return reply.send(stats);
  });
}
