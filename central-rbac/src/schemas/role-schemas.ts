/**
 * role-schemas.ts — Zod schemas for role request/response validation.
 */
import { z } from 'zod';

const roleKeySchema = z
  .string()
  .min(2)
  .max(128)
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, 'role key must be dot-separated lowercase');

export const createRoleSchema = z.object({
  key: roleKeySchema,
  description: z.string().max(500).default(''),
  parent_key: z.string().max(128).optional().nullable(),
});

export const updateRoleSchema = z
  .object({
    description: z.string().max(500).optional(),
    parent_key: z.string().max(128).optional().nullable(),
  })
  .strict();

export const rolePermissionBodySchema = z.object({
  permission_key: z.string().min(1).max(128),
});

export const roleKeyParamSchema = z.object({
  key: z.string().min(1).max(128),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
