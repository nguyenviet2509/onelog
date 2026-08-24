/**
 * routes/permissions.ts — CRUD for /v1/permissions.
 * key is immutable after creation (PATCH rejects key change).
 * All mutations write audit log.
 */
import type { FastifyInstance } from 'fastify';
import { verifyJwt } from '../middleware/auth-jwt.js';
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
  app.get('/v1/permissions', { preHandler: [verifyJwt] }, async (_req, reply) => {
    const perms = await listPermissions(writerPool);
    return reply.send({ data: perms });
  });

  // GET /v1/permissions/:key
  app.get('/v1/permissions/:key', { preHandler: [verifyJwt] }, async (request, reply) => {
    const p = permissionKeyParamSchema.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'Invalid key' });

    const perm = await getPermissionByKey(writerPool, p.data.key);
    if (!perm) return reply.status(404).send({ error: 'Permission not found' });
    return reply.send(perm);
  });

  // POST /v1/permissions
  app.post('/v1/permissions', { preHandler: [verifyJwt] }, async (request, reply) => {
    const parsed = createPermissionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
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
  app.patch('/v1/permissions/:key', { preHandler: [verifyJwt] }, async (request, reply) => {
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
  app.delete('/v1/permissions/:key', { preHandler: [verifyJwt] }, async (request, reply) => {
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
  app.get('/v1/permissions/:key/stats', { preHandler: [verifyJwt] }, async (request, reply) => {
    const p = permissionKeyParamSchema.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'Invalid key' });

    const stats = await getPermissionStats(writerPool, p.data.key);
    if (!stats) return reply.status(404).send({ error: 'Permission not found' });
    return reply.send(stats);
  });
}
