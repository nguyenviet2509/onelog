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

// ── Phase 02 — user provision ────────────────────────────────────────────────

export const createUserBodySchema = z.object({
  email: z.string().email().max(200),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  display_name: z.string().max(200).optional(),
  /** Optional — falls back to env ZITADEL_ORG_ID if unset. Admin can target another org. */
  org_id: z.string().max(64).optional(),
  /** default true → Zitadel emails set-password link */
  send_invite: z.boolean().default(true),
  preferred_language: z.string().max(10).optional(),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type UserIdParam = z.infer<typeof userIdParamSchema>;
export type CreateUserBody = z.infer<typeof createUserBodySchema>;
