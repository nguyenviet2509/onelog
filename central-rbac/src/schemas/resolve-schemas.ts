/**
 * resolve-schemas.ts — Zod schemas for /v1/resolve endpoint.
 */
import { z } from 'zod';

export const resolveBodySchema = z.object({
  roles: z
    .array(z.string().min(1).max(128))
    .min(1, 'at least one role required')
    .max(50, 'max 50 roles per request'),
});

export const resolveResponseSchema = z.object({
  permissions: z.array(z.string()),
  roles_expanded: z.array(z.string()),
  cached: z.boolean().default(false),
});

export type ResolveBody = z.infer<typeof resolveBodySchema>;
