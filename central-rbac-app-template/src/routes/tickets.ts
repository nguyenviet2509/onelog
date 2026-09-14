/**
 * routes/tickets.ts — Example CRUD với requirePermission preHandler.
 *
 * 3 endpoints demonstrating different permission checks:
 *   GET  /tickets       — viewer+ (permission: template-app:tickets.list)
 *   POST /tickets       — member+ (permission: template-app:tickets.create)
 *   DELETE /tickets/:id — admin only (permission: template-app:tickets.delete.any)
 *
 * Tenant-aware: tenantIdFrom='query.dept' extracts dept from ?dept=X query param.
 * If tenant_id omitted, resolves global grants only.
 */
import type { FastifyInstance } from 'fastify';

// In-memory storage cho demo (production: Postgres/etc.)
const tickets: Array<{ id: string; title: string; dept: string | null }> = [];
let nextId = 1;

export async function ticketRoutes(app: FastifyInstance): Promise<void> {
  // List — viewer+
  app.get(
    '/tickets',
    { preHandler: app.rbac.requirePermission('template-app:tickets.list', { tenantIdFrom: 'query.dept' }) },
    async (request) => {
      const dept = (request.query as Record<string, string>)['dept'] ?? null;
      const filtered = dept ? tickets.filter((t) => t.dept === dept) : tickets;
      return { tickets: filtered };
    },
  );

  // Create — member+
  app.post(
    '/tickets',
    { preHandler: app.rbac.requirePermission('template-app:tickets.create', { tenantIdFrom: 'body.dept' }) },
    async (request, reply) => {
      const body = request.body as { title?: string; dept?: string };
      if (!body.title) {
        return reply.status(400).send({ error: 'title required' });
      }
      const ticket = { id: String(nextId++), title: body.title, dept: body.dept ?? null };
      tickets.push(ticket);
      return reply.status(201).send({ ticket });
    },
  );

  // Delete — admin only
  app.delete<{ Params: { id: string } }>(
    '/tickets/:id',
    { preHandler: app.rbac.requirePermission('template-app:tickets.delete.any', { tenantIdFrom: 'query.dept' }) },
    async (request, reply) => {
      const idx = tickets.findIndex((t) => t.id === request.params.id);
      if (idx === -1) {
        return reply.status(404).send({ error: 'ticket not found' });
      }
      tickets.splice(idx, 1);
      return reply.send({ deleted: true });
    },
  );
}
