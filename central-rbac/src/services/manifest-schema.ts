/**
 * services/manifest-schema.ts — RBAC permissions manifest schema.
 * Phase 08. Single source-of-truth JSON Schema exposed at:
 *   GET /.well-known/rbac-permissions-schema.json  (for app developers)
 *
 * Apps publish their own manifest at their /.well-known/rbac-permissions.json
 * conforming to this schema. Central-rbac fetches + validates via zod.
 */
import { z } from 'zod';

export const MANIFEST_SCHEMA_VERSION = '1';

// Permission ID: <service>:<resource>.<action> — segments split on ':'
// First segment MUST match manifest.service exactly (namespace enforcement, Fix #13).
const PERMISSION_ID_REGEX = /^[a-z][a-z0-9-]{2,31}:[a-z][a-z0-9._-]+$/;

export const permissionEntrySchema = z.object({
  id: z.string().regex(PERMISSION_ID_REGEX, 'id must match ^<service>:<resource>.<action>$'),
  description: z.string().min(1).max(500),
  since_version: z.string().optional(),
  status: z.enum(['active', 'soft-deleted']).default('active'),
  alias_of: z
    .string()
    .regex(PERMISSION_ID_REGEX, 'alias_of must be a valid permission id')
    .optional(),
});

export const defaultRoleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{2,31}\.[a-z][a-z0-9]{1,31}$/, 'role key must match <slug>.<name>'),
  description: z.string().optional(),
  permissions: z.array(z.string().regex(PERMISSION_ID_REGEX)).min(0),
});

export const manifestSchema = z.object({
  schema: z.literal(MANIFEST_SCHEMA_VERSION),
  service: z.string().regex(/^[a-z][a-z0-9-]{2,31}$/, 'service must match app slug format'),
  version: z.string().min(1).max(64),
  permissions: z.array(permissionEntrySchema).min(0).max(500),
  default_roles: z.array(defaultRoleSchema).min(0).max(50).optional(),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type PermissionEntry = z.infer<typeof permissionEntrySchema>;
export type DefaultRole = z.infer<typeof defaultRoleSchema>;

/**
 * JSON Schema representation for /.well-known publication.
 * Kept in sync with zod schema above — updated when zod changes.
 */
export const manifestJsonSchema = {
  $schema: 'https://json-schema.org/draft-07/schema#',
  $id: 'https://central-rbac.local/.well-known/rbac-permissions-schema.json',
  title: 'OneLog Central RBAC Permission Manifest',
  type: 'object',
  required: ['schema', 'service', 'version', 'permissions'],
  properties: {
    schema: { const: MANIFEST_SCHEMA_VERSION },
    service: {
      type: 'string',
      pattern: '^[a-z][a-z0-9-]{2,31}$',
      description: 'App slug — MUST match rbac.apps.slug exactly (namespace claim)',
    },
    version: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description: 'Semver or date-string identifying manifest version',
    },
    permissions: {
      type: 'array',
      minItems: 0,
      maxItems: 500,
      items: {
        type: 'object',
        required: ['id', 'description'],
        properties: {
          id: {
            type: 'string',
            pattern: '^[a-z][a-z0-9-]{2,31}:[a-z][a-z0-9._-]+$',
            description: 'Permission id format <service>:<resource>.<action>',
          },
          description: { type: 'string', minLength: 1, maxLength: 500 },
          since_version: { type: 'string' },
          status: { enum: ['active', 'soft-deleted'], default: 'active' },
          alias_of: {
            type: 'string',
            pattern: '^[a-z][a-z0-9-]{2,31}:[a-z][a-z0-9._-]+$',
          },
        },
      },
    },
    default_roles: {
      type: 'array',
      minItems: 0,
      maxItems: 50,
      items: {
        type: 'object',
        required: ['key', 'permissions'],
        properties: {
          key: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,31}\\.[a-z][a-z0-9]{1,31}$' },
          description: { type: 'string' },
          permissions: {
            type: 'array',
            items: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,31}:[a-z][a-z0-9._-]+$' },
          },
        },
      },
    },
  },
} as const;
