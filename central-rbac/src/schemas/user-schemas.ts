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

// ── Phase 02 / 03 — user provision ───────────────────────────────────────────

/**
 * Provision mode — matches Zitadel Console's create-user form (subset).
 *   invite_email — Zitadel sends verification + set-password link (needs SMTP)
 *   set_password — admin picks initial password; user forced to change on 1st login
 * Default is `set_password` because Zitadel SMTP is not yet configured for INET.
 * `setup_later` was dropped 2026-09-03 — admin never used it in practice.
 */
export const provisionModeSchema = z.enum(['invite_email', 'set_password']);
export type ProvisionMode = z.infer<typeof provisionModeSchema>;

export const createUserBodySchema = z
  .object({
    email: z.string().email().max(200),
    first_name: z.string().min(1).max(100),
    last_name: z.string().min(1).max(100),
    display_name: z.string().max(200).optional(),
    org_id: z.string().max(64).optional(),
    mode: provisionModeSchema.default('set_password'),
    /** Required when mode === 'set_password'. Zitadel enforces complexity policy. */
    password: z.string().min(1).max(200).optional(),
    /** default true — user must rotate the admin-set password on first login */
    password_change_required: z.boolean().default(true),
    preferred_language: z.string().max(10).optional(),
  })
  .refine((v) => v.mode !== 'set_password' || !!v.password, {
    message: 'password required when mode = set_password',
    path: ['password'],
  });

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type UserIdParam = z.infer<typeof userIdParamSchema>;
export type CreateUserBody = z.infer<typeof createUserBodySchema>;
