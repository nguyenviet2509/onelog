/**
 * routes/roles.ts — CRUD for /v1/roles + role_permissions + hierarchy.
 * Enforces single-parent + cycle check before DB write.
 * All mutations write audit log.
 */
import type { FastifyInstance } from 'fastify';
import { verifyJwt } from '../middleware/auth-jwt.js';
import { writeAuditLog } from '../middleware/audit-log.js';
import { writerPool } from '../db/writer-pool.js';
import {
  listRoles, getRoleByKey, createRole, updateRole, deleteRole,
  getRolePermissions, addRolePermission, removeRolePermission,
  getAllRolesFlat, getRoleStats,
} from '../db/queries/roles.js';
import { getPermissionByKey } from '../db/queries/permissions.js';
import { wouldCreateCycle } from '../lib/cycle-check.js';
import {
  createRoleSchema, updateRoleSchema,
  rolePermissionBodySchema, roleKeyParamSchema,
} from '../schemas/role-schemas.js';

export async function roleRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/roles
  app.get('/v1/roles', { preHandler: [verifyJwt] }, async (_req, reply) => {
    return reply.send({ data: await listRoles(writerPool) });
  });

  // GET /v1/roles/:key
  app.get('/v1/roles/:key', { preHandler: [verifyJwt] }, async (request, reply) => {
    const p = roleKeyParamSchema.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'Invalid key' });
    const role = await getRoleByKey(writerPool, p.data.key);
    if (!role) return reply.status(404).send({ error: 'Role not found' });
    return reply.send(role);
  });

  // POST /v1/roles
  app.post('/v1/roles', { preHandler: [verifyJwt] }, async (request, reply) => {
    const parsed = createRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
    }

    const existing = await getRoleByKey(writerPool, parsed.data.key);
    if (existing) return reply.status(409).send({ error: 'Role key already exists' });

    if (parsed.data.parent_key) {
      const parent = await getRoleByKey(writerPool, parsed.data.parent_key);
      if (!parent) return reply.status(422).send({ error: 'parent_key does not exist' });
    }

    const role = await createRole(writerPool, parsed.data);
    await writeAuditLog(request, {
      action: 'role.create', target_type: 'role', target_id: role.key, after_state: role,
    });
    return reply.status(201).send(role);
  });

  // PATCH /v1/roles/:key
  app.patch('/v1/roles/:key', { preHandler: [verifyJwt] }, async (request, reply) => {
    const p = roleKeyParamSchema.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'Invalid key' });

    const parsed = updateRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
    }

    const before = await getRoleByKey(writerPool, p.data.key);
    if (!before) return reply.status(404).send({ error: 'Role not found' });

    // Cycle check before parent update
    if (parsed.data.parent_key !== undefined && parsed.data.parent_key !== null) {
      const allRoles = await getAllRolesFlat(writerPool);
      if (wouldCreateCycle(allRoles, p.data.key, parsed.data.parent_key)) {
        return reply.status(422).send({ error: 'Setting this parent would create a cycle' });
      }
      const parent = await getRoleByKey(writerPool, parsed.data.parent_key);
      if (!parent) return reply.status(422).send({ error: 'parent_key does not exist' });
    }

    const updated = await updateRole(writerPool, p.data.key, parsed.data);
    if (!updated) return reply.status(404).send({ error: 'Role not found' });

    await writeAuditLog(request, {
      action: 'role.update', target_type: 'role', target_id: p.data.key,
      before_state: before, after_state: updated,
    });
    return reply.send(updated);
  });

  // DELETE /v1/roles/:key
  app.delete('/v1/roles/:key', { preHandler: [verifyJwt] }, async (request, reply) => {
    const p = roleKeyParamSchema.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'Invalid key' });

    const before = await getRoleByKey(writerPool, p.data.key);
    if (!before) return reply.status(404).send({ error: 'Role not found' });

    await deleteRole(writerPool, p.data.key);
    await writeAuditLog(request, {
      action: 'role.delete', target_type: 'role', target_id: p.data.key, before_state: before,
    });
    return reply.status(204).send();
  });

  // GET /v1/roles/:key/permissions
  app.get('/v1/roles/:key/permissions', { preHandler: [verifyJwt] }, async (request, reply) => {
    const p = roleKeyParamSchema.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'Invalid key' });
    const role = await getRoleByKey(writerPool, p.data.key);
    if (!role) return reply.status(404).send({ error: 'Role not found' });
    const perms = await getRolePermissions(writerPool, p.data.key);
    return reply.send({ data: perms });
  });

  // POST /v1/roles/:key/permissions
  app.post('/v1/roles/:key/permissions', { preHandler: [verifyJwt] }, async (request, reply) => {
    const p = roleKeyParamSchema.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'Invalid key' });

    const parsed = rolePermissionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation error', details: parsed.error.issues });
    }

    const role = await getRoleByKey(writerPool, p.data.key);
    if (!role) return reply.status(404).send({ error: 'Role not found' });

    const perm = await getPermissionByKey(writerPool, parsed.data.permission_key);
    if (!perm) return reply.status(422).send({ error: 'permission_key does not exist' });

    await addRolePermission(writerPool, p.data.key, parsed.data.permission_key);
    await writeAuditLog(request, {
      action: 'role_permission.add', target_type: 'role_permission',
      target_id: `${p.data.key}:${parsed.data.permission_key}`,
      after_state: { role_key: p.data.key, permission_key: parsed.data.permission_key },
    });
    return reply.status(201).send({ role_key: p.data.key, permission_key: parsed.data.permission_key });
  });

  // DELETE /v1/roles/:key/permissions/:permKey
  app.delete('/v1/roles/:key/permissions/:permKey', { preHandler: [verifyJwt] }, async (request, reply) => {
    const params = request.params as { key: string; permKey: string };
    const role = await getRoleByKey(writerPool, params.key);
    if (!role) return reply.status(404).send({ error: 'Role not found' });

    const removed = await removeRolePermission(writerPool, params.key, params.permKey);
    if (!removed) return reply.status(404).send({ error: 'Role-permission assignment not found' });

    await writeAuditLog(request, {
      action: 'role_permission.remove', target_type: 'role_permission',
      target_id: `${params.key}:${params.permKey}`,
      before_state: { role_key: params.key, permission_key: params.permKey },
    });
    return reply.status(204).send();
  });

  // GET /v1/roles/:key/stats
  app.get('/v1/roles/:key/stats', { preHandler: [verifyJwt] }, async (request, reply) => {
    const p = roleKeyParamSchema.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'Invalid key' });
    const stats = await getRoleStats(writerPool, p.data.key);
    if (!stats) return reply.status(404).send({ error: 'Role not found' });
    return reply.send(stats);
  });
}
