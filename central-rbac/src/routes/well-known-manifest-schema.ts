/**
 * routes/well-known-manifest-schema.ts — publish JSON Schema for RBAC permission manifests.
 * Phase 08. App developers fetch schema from here to validate their manifest before deploying.
 *
 * GET /.well-known/rbac-permissions-schema.json  (public, no auth)
 */
import type { FastifyInstance } from 'fastify';
import { manifestJsonSchema, MANIFEST_SCHEMA_VERSION } from '../services/manifest-schema.js';

export async function wellKnownManifestSchemaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/.well-known/rbac-permissions-schema.json', async (_req, reply) => {
    return reply
      .header('Cache-Control', 'public, max-age=3600')
      .header('Content-Type', 'application/schema+json')
      .send(manifestJsonSchema);
  });

  app.get('/.well-known/rbac-permissions-schema-version', async (_req, reply) => {
    return reply
      .header('Cache-Control', 'public, max-age=3600')
      .send({ schema_version: MANIFEST_SCHEMA_VERSION });
  });
}
