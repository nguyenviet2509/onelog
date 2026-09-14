/**
 * routes/well-known-manifest-schema.ts — publish JSON Schema for RBAC permission manifests.
 * Phase 08: v1 schema. Phase 09 (plan 260910-1334): v2 schema.
 * App developers fetch schema from here to validate their manifest before deploying.
 *
 * GET /.well-known/rbac-permissions-schema.json      (v1, public, no auth)
 * GET /.well-known/rbac-permissions-schema-v2.json   (v2, public, no auth)
 * GET /.well-known/rbac-permissions-schema-version   (list supported versions)
 */
import type { FastifyInstance } from 'fastify';
import {
  manifestJsonSchema,
  manifestJsonSchemaV2,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION_V2,
} from '../services/manifest-schema.js';

export async function wellKnownManifestSchemaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/.well-known/rbac-permissions-schema.json', async (_req, reply) => {
    return reply
      .header('Cache-Control', 'public, max-age=3600')
      .header('Content-Type', 'application/schema+json')
      .send(manifestJsonSchema);
  });

  app.get('/.well-known/rbac-permissions-schema-v2.json', async (_req, reply) => {
    return reply
      .header('Cache-Control', 'public, max-age=3600')
      .header('Content-Type', 'application/schema+json')
      .send(manifestJsonSchemaV2);
  });

  app.get('/.well-known/rbac-permissions-schema-version', async (_req, reply) => {
    return reply
      .header('Cache-Control', 'public, max-age=3600')
      .send({
        schema_version: MANIFEST_SCHEMA_VERSION,
        supported_versions: [MANIFEST_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION_V2],
      });
  });
}
