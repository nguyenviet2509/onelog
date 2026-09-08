-- =============================================================================
-- Migration 015: rbac.apps.client_type — OIDC client type (web / spa / native)
--
-- Enables Central RBAC wizard + PATCH endpoint to fully manage OIDC client mode
-- without admin dropping into Zitadel Console.
--
-- Mapping stored here → resolved to Zitadel enums in application layer:
--   web    → appType=OIDC_APP_TYPE_WEB,        authMethodType=BASIC (confidential)
--   spa    → appType=OIDC_APP_TYPE_USER_AGENT, authMethodType=NONE  (public + PKCE)
--   native → appType=OIDC_APP_TYPE_NATIVE,     authMethodType=NONE  (public + PKCE)
--
-- Default 'web' preserves backward compat with legacy apps created before Phase 09.
-- Backfill qlts → 'spa' (Zitadel side already switched manually 2026-09-07).
-- =============================================================================

SET search_path = rbac, public;

ALTER TABLE rbac.apps
  ADD COLUMN IF NOT EXISTS client_type TEXT NOT NULL DEFAULT 'web'
    CHECK (client_type IN ('web', 'spa', 'native'));

COMMENT ON COLUMN rbac.apps.client_type IS
  'OIDC client type: web (confidential/BASIC), spa (USER_AGENT/PKCE), native (NATIVE/PKCE). Resolved to Zitadel enums by zitadel-oidc-app-client.ts CLIENT_TYPE_MAP.';

-- Backfill qlts (idempotent — guarded by slug + current value)
UPDATE rbac.apps
   SET client_type = 'spa'
 WHERE slug = 'qlts'
   AND client_type = 'web';

INSERT INTO rbac.schema_migrations (version, description)
VALUES (15, 'apps.client_type column + qlts backfill spa')
ON CONFLICT (version) DO NOTHING;
