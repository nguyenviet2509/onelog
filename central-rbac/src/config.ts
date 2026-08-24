/**
 * config.ts — Environment validation at startup.
 * Fails fast with clear error if required vars are missing.
 */
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // DB connections
  WRITER_DATABASE_URL: z.string().url('WRITER_DATABASE_URL must be a valid postgres URL'),
  AUDITOR_DATABASE_URL: z.string().url('AUDITOR_DATABASE_URL must be a valid postgres URL'),

  // Zitadel JWT
  ZITADEL_ISSUER: z.string().min(1, 'ZITADEL_ISSUER required'),
  ZITADEL_JWKS_URL: z.string().url('ZITADEL_JWKS_URL must be a valid URL'),
  ZITADEL_AUD_CLIENT_ID: z.string().min(1, 'ZITADEL_AUD_CLIENT_ID required'),
  ZITADEL_AZP_ADMIN_CLIENT_ID: z.string().min(1, 'ZITADEL_AZP_ADMIN_CLIENT_ID required'),

  // Resolve auth — startup fails if empty (F4 fix)
  CENTRAL_RBAC_RESOLVE_TOKEN: z.string().min(16, 'CENTRAL_RBAC_RESOLVE_TOKEN must be ≥16 chars'),
  ZITADEL_ACTION_SIGNING_KEY: z.string().min(16, 'ZITADEL_ACTION_SIGNING_KEY must be ≥16 chars'),

  // VictoriaLogs dual-write — empty string treated as unset (not validated as URL)
  VL_INGEST_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v : undefined))
    .pipe(z.string().url('VL_INGEST_URL must be a valid URL').optional()),

  // CORS — comma-separated allow-list for Phase 5 UI subdomain (H2 fix).
  // Empty string = no CORS in prod (safe default). Dev falls back to allow-all.
  // Example: CENTRAL_RBAC_CORS_ORIGIN=https://rbac.inet.vn,https://admin.inet.vn
  CENTRAL_RBAC_CORS_ORIGIN: z.string().default(''),

  // Redis
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6380),
  REDIS_PASSWORD: z.string().default(''),

  // Zitadel Management API
  ZITADEL_MGMT_URL: z.string().url('ZITADEL_MGMT_URL must be a valid URL').default('http://authway-vps.local:8080'),
  ZITADEL_SA_PAT: z.string().default(''),   // optional in dev; required if Mgmt API calls needed
  ZITADEL_ORG_ID: z.string().default(''),   // default org context for ListUserGrants

  // Break-glass
  BREAK_GLASS_USER_ID: z.string().default(''),
  BREAK_GLASS_PERMS: z.string().default(''),

  // Admin fail-close role pattern (regex) — roles matching this trigger fail-close path
  FAIL_CLOSE_ROLE_PATTERN: z.string().default('^(rbac\\..*|.*\\.admin)$'),

  // Feature flags
  WEBHOOK_ECHO_ENABLED: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .default('false'),
});

export type AppConfig = z.infer<typeof envSchema>;

function loadConfig(): AppConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration error — fix these env vars before starting:\n${issues}`);
  }
  return result.data;
}

// Singleton — exported for use across the app
export const config = loadConfig();
