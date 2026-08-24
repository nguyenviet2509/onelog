/**
 * permission-schemas.ts — Zod schemas for permission request/response validation.
 */
import { z } from 'zod';

// permission key format: <service>.<resource>.<action>
const permissionKeySchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+){1,4}$/, 'key must match <service>.<resource>.<action>');

export const createPermissionSchema = z.object({
  key: permissionKeySchema,
  description: z.string().max(500).default(''),
  alias_of: z.string().optional().nullable(),
});

export const updatePermissionSchema = z
  .object({
    // key is intentionally excluded — immutable after creation (F-spec)
    description: z.string().max(500).optional(),
    alias_of: z.string().optional().nullable(),
    deprecated: z.boolean().optional(),
  })
  .strict();

export const permissionKeyParamSchema = z.object({
  key: z.string().min(1).max(128),
});

export type CreatePermissionInput = z.infer<typeof createPermissionSchema>;
export type UpdatePermissionInput = z.infer<typeof updatePermissionSchema>;
