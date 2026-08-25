/**
 * schemas/user-schemas.ts — Zod schemas for /v1/users proxy endpoints.
 * Validates query params and response shapes for the Zitadel user search proxy.
 */
import { z } from 'zod';

export const listUsersQuerySchema = z.object({
  q: z.string().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const userIdParamSchema = z.object({
  id: z.string().min(1).max(128),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type UserIdParam = z.infer<typeof userIdParamSchema>;
