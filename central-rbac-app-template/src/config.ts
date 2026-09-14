/**
 * config.ts — Env config với zod validation.
 */
import { z } from 'zod';

const schema = z.object({
  CENTRAL_URL: z.string().url(),
  APP_SLUG: z.string().regex(/^[a-z][a-z0-9-]{2,31}$/),
  CENTRAL_RBAC_TOKEN: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export const config = schema.parse(process.env);
