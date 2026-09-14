/**
 * services/manifest-schema.ts — RBAC permissions manifest schema.
 *
 * Phase 08: v1 flat schema. Single source-of-truth published at:
 *   GET /.well-known/rbac-permissions-schema.json  (v1, backward compat)
 *
 * Phase 09 (plan 260910-1334): v2 adds hierarchy (parent_key), delegation (can_grant),
 * tenant scope (tenant_aware, tenant_lookup_url). Published at:
 *   GET /.well-known/rbac-permissions-schema-v2.json
 *
 * Apps publish their own manifest at /.well-known/rbac-permissions.json.
 * Central detects version via `schema` field (discriminated union).
 */
import { z } from 'zod';

export const MANIFEST_SCHEMA_VERSION = '1';
export const MANIFEST_SCHEMA_VERSION_V2 = '2';

// Permission ID: <service>:<resource>.<action> — segments split on ':'
// First segment MUST match manifest.service exactly (namespace enforcement, Fix #13).
const PERMISSION_ID_REGEX = /^[a-z][a-z0-9-]{2,31}:[a-z][a-z0-9._-]+$/;

// Role key: <slug>.<name>
const ROLE_KEY_REGEX = /^[a-z][a-z0-9-]{2,31}\.[a-z][a-z0-9]{1,31}$/;

// Service slug: same as app.slug format
const SERVICE_SLUG_REGEX = /^[a-z][a-z0-9-]{2,31}$/;

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

// ── v1 (Phase 08, flat) ──────────────────────────────────────────────────────

export const defaultRoleSchema = z.object({
  key: z.string().regex(ROLE_KEY_REGEX, 'role key must match <slug>.<name>'),
  description: z.string().optional(),
  permissions: z.array(z.string().regex(PERMISSION_ID_REGEX)).min(0),
});

export const manifestSchemaV1 = z.object({
  schema: z.literal(MANIFEST_SCHEMA_VERSION),
  service: z.string().regex(SERVICE_SLUG_REGEX, 'service must match app slug format'),
  version: z.string().min(1).max(64),
  permissions: z.array(permissionEntrySchema).min(0).max(500),
  default_roles: z.array(defaultRoleSchema).min(0).max(50).optional(),
});

/** @deprecated Use `manifestSchemaV1`. Kept as alias for backward-compat imports. */
export const manifestSchema = manifestSchemaV1;

// ── v2 (Phase 09 plan 260910-1334, hierarchy + delegation + tenant) ──────────

export const defaultRoleSchemaV2 = z.object({
  key: z.string().regex(ROLE_KEY_REGEX, 'role key must match <slug>.<name>'),
  parent_key: z.string().regex(ROLE_KEY_REGEX).nullable().optional(),
  description: z.string().optional(),
  permissions: z.array(z.string().regex(PERMISSION_ID_REGEX)).min(0),
  can_grant: z.array(z.string().regex(ROLE_KEY_REGEX)).default([]),
});

export const manifestSchemaV2 = z.object({
  schema: z.literal(MANIFEST_SCHEMA_VERSION_V2),
  service: z.string().regex(SERVICE_SLUG_REGEX, 'service must match app slug format'),
  version: z.string().min(1).max(64),
  tenant_aware: z.boolean().default(false),
  tenant_lookup_url: z.string().url().startsWith('https://').optional(),
  permissions: z.array(permissionEntrySchema).min(0).max(500),
  default_roles: z.array(defaultRoleSchemaV2).min(0).max(50).optional(),
});

// Discriminated union — parse detects version via `schema` field
export const manifestSchemaAny = z.discriminatedUnion('schema', [manifestSchemaV1, manifestSchemaV2]);

// ── Type exports ─────────────────────────────────────────────────────────────

export type ManifestV1 = z.infer<typeof manifestSchemaV1>;
export type ManifestV2 = z.infer<typeof manifestSchemaV2>;
export type Manifest = ManifestV1;  // v1 default (backward compat)
export type ManifestAny = z.infer<typeof manifestSchemaAny>;
export type PermissionEntry = z.infer<typeof permissionEntrySchema>;
export type DefaultRole = z.infer<typeof defaultRoleSchema>;
export type DefaultRoleV2 = z.infer<typeof defaultRoleSchemaV2>;

// ── JSON Schema for /.well-known publication ─────────────────────────────────

export const manifestJsonSchema = {
  $schema: 'https://json-schema.org/draft-07/schema#',
  $id: 'https://central-rbac.local/.well-known/rbac-permissions-schema.json',
  title: 'OneLog Central RBAC Permission Manifest (v1)',
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

export const manifestJsonSchemaV2 = {
  $schema: 'https://json-schema.org/draft-07/schema#',
  $id: 'https://central-rbac.local/.well-known/rbac-permissions-schema-v2.json',
  title: 'OneLog Central RBAC Permission Manifest (v2 — hierarchy + delegation + tenant)',
  type: 'object',
  required: ['schema', 'service', 'version', 'permissions'],
  properties: {
    schema: { const: MANIFEST_SCHEMA_VERSION_V2 },
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
    tenant_aware: {
      type: 'boolean',
      default: false,
      description: 'App supports tenant-scoped grants (dept-A, org-X, ...). Opaque tenant IDs; Central không validate existence.',
    },
    tenant_lookup_url: {
      type: 'string',
      format: 'uri',
      pattern: '^https://',
      description: 'HTTPS endpoint to enrich tenant_id → display name in Central UI. SSRF-guarded (block private IPs).',
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
          key: {
            type: 'string',
            pattern: '^[a-z][a-z0-9-]{2,31}\\.[a-z][a-z0-9]{1,31}$',
          },
          parent_key: {
            type: ['string', 'null'],
            pattern: '^[a-z][a-z0-9-]{2,31}\\.[a-z][a-z0-9]{1,31}$',
            description: 'Optional parent role key for hierarchy (viewer → member → admin chain)',
          },
          description: { type: 'string' },
          permissions: {
            type: 'array',
            items: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,31}:[a-z][a-z0-9._-]+$' },
          },
          can_grant: {
            type: 'array',
            default: [],
            items: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,31}\\.[a-z][a-z0-9]{1,31}$' },
            description: 'Delegation whitelist — this role can grant these role_keys to other users. Empty = no delegation.',
          },
        },
      },
    },
  },
} as const;
