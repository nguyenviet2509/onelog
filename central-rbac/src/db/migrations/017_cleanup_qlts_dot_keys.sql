-- =============================================================================
-- Migration 017: cleanup qlts.* dot-format permission keys (mistake in 016)
--
-- Migration 016 seeded 91 permissions using DOT format (`qlts.assets.read`).
-- Central schema (manifest-schema.ts:15) mandates COLON format
-- `<service>:<resource>.<action>` (as adopted by OneMCP: `onemcp:admin.settings`).
--
-- This migration removes the mis-formatted keys so the qlts manifest sync
-- (which will publish keys as `qlts:assets.read` per schema) starts clean —
-- no duplicates between old dot-keys and new colon-keys.
--
-- Safety: verified 0 rows in `rbac.role_permissions` reference `qlts.%` keys
-- before running. If any exist by the time this runs, DELETE will fail on FK
-- constraint (fail-safe) — abort and reconcile grants first.
-- =============================================================================

BEGIN;

-- Delete 91 dot-format qlts permissions. FK constraint on role_permissions
-- protects against accidental delete when grants exist.
DELETE FROM rbac.permissions
 WHERE key LIKE 'qlts.%';

-- Record migration
INSERT INTO rbac.schema_migrations (version, description) VALUES
  (17, 'cleanup qlts.* dot-format permission keys (from migration 016 mistake) — colon format keys will be seeded via manifest sync from qlts backend')
ON CONFLICT (version) DO NOTHING;

COMMIT;
