-- 019_rollback.sql — Rollback for 019_rbac_v2_foundation.sql.
--
-- Chạy khi cần revert Migration 019 (VD: prod incident, corrupted state).
-- WARNING: DELETE rbac.user_grants → mất data grants. Backup trước qua
-- scripts/pre-migration-019-backup.sh.
--
-- Audit log rows KHÔNG delete (append-only trigger reject). Chấp nhận orphan.

SET lock_timeout = '30s';
SET statement_timeout = '60s';

BEGIN;

-- ============================================================================
-- 1. Drop triggers (must drop before functions)
-- ============================================================================
DROP TRIGGER IF EXISTS user_grants_epoch_insert ON rbac.user_grants;
DROP TRIGGER IF EXISTS user_grants_epoch_update ON rbac.user_grants;
DROP TRIGGER IF EXISTS user_grants_epoch_delete ON rbac.user_grants;
DROP TRIGGER IF EXISTS role_permissions_epoch_insert ON rbac.role_permissions;
DROP TRIGGER IF EXISTS role_permissions_epoch_update ON rbac.role_permissions;
DROP TRIGGER IF EXISTS role_permissions_epoch_delete ON rbac.role_permissions;
DROP TRIGGER IF EXISTS roles_epoch_bump ON rbac.roles;
DROP TRIGGER IF EXISTS roles_parent_cycle_check ON rbac.roles;

DROP FUNCTION IF EXISTS rbac.bump_epochs_from_grants_upsert();
DROP FUNCTION IF EXISTS rbac.bump_epochs_from_grants_delete();
DROP FUNCTION IF EXISTS rbac.bump_epochs_from_role_perms_upsert();
DROP FUNCTION IF EXISTS rbac.bump_epochs_from_role_perms_delete();
DROP FUNCTION IF EXISTS rbac.bump_epochs_from_roles();
DROP FUNCTION IF EXISTS rbac.validate_role_parent_no_cycle();

-- ============================================================================
-- 2. Drop table user_grants (indexes tự động drop)
-- ============================================================================
DROP TABLE IF EXISTS rbac.user_grants;

-- ============================================================================
-- 3. Drop columns
-- ============================================================================
ALTER TABLE rbac.apps DROP COLUMN IF EXISTS permission_epoch;
ALTER TABLE rbac.roles DROP COLUMN IF EXISTS can_grant;

-- ============================================================================
-- 4. Restore original roles.source CHECK constraint
-- ============================================================================
ALTER TABLE rbac.roles DROP CONSTRAINT IF EXISTS roles_source_check;
ALTER TABLE rbac.roles ADD CONSTRAINT roles_source_check
  CHECK (source IN ('manual', 'manifest'));

-- ============================================================================
-- 5. Remove seed data
-- ============================================================================
DELETE FROM rbac.roles WHERE key = 'central.operator';
DELETE FROM rbac.apps WHERE slug = 'central';

-- ============================================================================
-- 6. Remove migration record
-- ============================================================================
DELETE FROM rbac.schema_migrations WHERE version = 19;

COMMIT;

RESET lock_timeout;
RESET statement_timeout;
