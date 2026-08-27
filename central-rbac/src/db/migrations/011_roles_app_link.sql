-- =============================================================================
-- Migration 011: link rbac.roles to rbac.apps for multi-project awareness.
-- Discovered during Phase 08 e2e test 2026-08-27:
--   Wizard-created roles (onemcp.*) had no link to Zitadel project of the app,
--   so grants targeted env ZITADEL_PROJECT_ID (central-rbac's project) instead of
--   the new app's Zitadel project → outbox events landed 'dead' with permanent
--   failure "role not found in project".
-- Fix: add nullable app_id column. Grant flow resolves projectId from role.app_id
--   → apps.zitadel_project_id. Legacy roles (app_id NULL) fall back to env
--   ZITADEL_PROJECT_ID for backward compat.
-- =============================================================================

SET search_path = rbac, public;

ALTER TABLE rbac.roles
  ADD COLUMN IF NOT EXISTS app_id UUID REFERENCES rbac.apps(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS roles_app_id_idx ON rbac.roles(app_id) WHERE app_id IS NOT NULL;

COMMENT ON COLUMN rbac.roles.app_id IS
  'Optional link to rbac.apps for wizard-created roles. NULL for legacy/bootstrap roles that use env ZITADEL_PROJECT_ID.';

-- Backfill: wizard-created default roles ({slug}.viewer/editor/admin) → link to matching app
UPDATE rbac.roles r
   SET app_id = a.id
  FROM rbac.apps a
 WHERE r.app_id IS NULL
   AND r.key LIKE a.slug || '.%';

INSERT INTO rbac.schema_migrations (version, description)
VALUES (11, 'roles.app_id FK for multi-project Zitadel grant routing')
ON CONFLICT (version) DO NOTHING;
