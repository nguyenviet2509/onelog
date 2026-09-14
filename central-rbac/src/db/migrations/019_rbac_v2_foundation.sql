-- 019_rbac_v2_foundation.sql — RBAC v2 foundation (tenant, delegation, epoch, central operator).
--
-- Plan: 260910-1334-central-rbac-v2-refactor phase 1.
--
-- Vấn đề: Central v1 chỉ có RBAC0 flat. Không có tenant scope, không có delegation
-- metadata, không có per-app epoch. Zitadel là source of truth cho user grants →
-- không query được ai có role gì khi Zitadel offline.
--
-- Fix:
--   1. CREATE TABLE rbac.user_grants — Central là source of truth cho user grants.
--   2. ALTER rbac.roles.source CHECK — thêm 'system' cho platform-managed roles.
--   3. ADD COLUMN rbac.roles.can_grant TEXT[] — delegation metadata.
--   4. ADD COLUMN rbac.apps.permission_epoch BIGINT — per-app epoch (song song global metadata).
--   5. STATEMENT-level triggers bump epoch (dual global + per-app).
--   6. BEFORE INSERT/UPDATE trigger validate role.parent_key không cycle.
--   7. Seed system data: dummy app 'central' + role 'central.operator' (safe cho prod).
--
-- Backwards compat: mọi thay đổi là ADD/ALTER additive. V1 endpoints/manifest KHÔNG break.
-- V1 grants (existing) có parent_key=NULL → Phase 4 outbox worker expand = self only → Zitadel state unchanged.
--
-- Bootstrap: user_grants seed KHÔNG hardcode trong migration — chạy scripts/019-bootstrap-operators.ts
-- env-driven (CENTRAL_OPERATOR_SUBS=<csv>) sau apply migration.

-- Guard preamble: fail fast thay vì hang production nếu bảng lock lâu.
SET lock_timeout = '30s';
SET statement_timeout = '60s';

BEGIN;

-- ============================================================================
-- 1. CREATE TABLE rbac.user_grants
-- ============================================================================
-- Central là source of truth cho grants (thay Zitadel). Columns:
--   - user_sub: Zitadel user ID (numeric string, VD '389119521513799683')
--   - app_id: FK rbac.apps.id (dummy 'central' app UUID cho global roles)
--   - role_key: FK rbac.roles.key (RESTRICT — không xoá role còn grant)
--   - tenant_id: opaque string (NULL = global grant); UNIQUE include tenant_id
--   - granted_by_sub: audit context ('system' = bootstrap, else Zitadel sub)

CREATE TABLE IF NOT EXISTS rbac.user_grants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub       TEXT NOT NULL,
  app_id         UUID NOT NULL REFERENCES rbac.apps(id) ON DELETE CASCADE,
  role_key       TEXT NOT NULL REFERENCES rbac.roles(key) ON DELETE RESTRICT,
  tenant_id      TEXT NULL,
  granted_by_sub TEXT NOT NULL DEFAULT 'system',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_sub, app_id, role_key, tenant_id)
);

COMMENT ON TABLE rbac.user_grants IS
  'Central-side user grants (Migration 019). Source of truth thay Zitadel user_grants.';
COMMENT ON COLUMN rbac.user_grants.tenant_id IS
  'Opaque tenant scope (NULL = global grant across all tenants). App tự quản lý tenant IDs — Central không validate existence.';
COMMENT ON COLUMN rbac.user_grants.granted_by_sub IS
  'Grantor Zitadel sub (audit context). "system" = bootstrap script.';

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS user_grants_user_sub_idx
  ON rbac.user_grants (user_sub);
CREATE INDEX IF NOT EXISTS user_grants_app_id_idx
  ON rbac.user_grants (app_id);
CREATE INDEX IF NOT EXISTS user_grants_app_tenant_idx
  ON rbac.user_grants (app_id, tenant_id)
  WHERE tenant_id IS NOT NULL;

-- Grants: writer INSERT/UPDATE/DELETE/SELECT, auditor SELECT
-- (rbac_reader vắng mặt trên một số deployment — dùng DO block để chỉ grant nếu role tồn tại)
GRANT SELECT, INSERT, UPDATE, DELETE ON rbac.user_grants TO rbac_writer;
GRANT SELECT ON rbac.user_grants TO rbac_auditor;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rbac_reader') THEN
    EXECUTE 'GRANT SELECT ON rbac.user_grants TO rbac_reader';
  END IF;
END$$;

-- ============================================================================
-- 2. ALTER rbac.roles.source CHECK — thêm 'system'
-- ============================================================================
-- Trước: source IN ('manual', 'manifest'). Thêm 'system' cho central.operator
-- (không edit qua UI, không sync qua manifest).

ALTER TABLE rbac.roles DROP CONSTRAINT IF EXISTS roles_source_check;
ALTER TABLE rbac.roles ADD CONSTRAINT roles_source_check
  CHECK (source IN ('manual', 'manifest', 'system'));

-- ============================================================================
-- 3. ADD COLUMN rbac.roles.can_grant + rbac.apps.permission_epoch
-- ============================================================================

ALTER TABLE rbac.roles
  ADD COLUMN IF NOT EXISTS can_grant TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN rbac.roles.can_grant IS
  'Delegation whitelist: role có thể grant các role_key trong list này. Empty = không grant được ai.';

ALTER TABLE rbac.apps
  ADD COLUMN IF NOT EXISTS permission_epoch BIGINT NOT NULL DEFAULT 1;

COMMENT ON COLUMN rbac.apps.permission_epoch IS
  'Per-app epoch (Migration 019). SDK poll để invalidate cache. Bump khi grants/roles thay đổi.';

-- ============================================================================
-- 4. TRIGGERS: bump_epochs (dual global + per-app, STATEMENT-level)
-- ============================================================================
-- STATEMENT-level thay ROW-level → bulk operations không cascade OOM.
-- REFERENCING transition tables cho phép access NEW/OLD rows trong function.
-- Dual-bump: global rbac.metadata.resolve_epoch (backward compat /v1) +
-- per-app rbac.apps.permission_epoch (SDK v2).

-- Function cho INSERT/UPDATE trên user_grants
CREATE OR REPLACE FUNCTION rbac.bump_epochs_from_grants_upsert()
RETURNS TRIGGER AS $$
BEGIN
  -- Global bump (backward compat /v1/resolve)
  INSERT INTO rbac.metadata (key, value, updated_at)
  VALUES ('resolve_epoch', '1', now())
  ON CONFLICT (key) DO UPDATE SET
    value = (COALESCE(rbac.metadata.value, '0')::bigint + 1)::text,
    updated_at = now();

  -- Per-app bump
  UPDATE rbac.apps
     SET permission_epoch = permission_epoch + 1
   WHERE id IN (SELECT DISTINCT app_id FROM new_grants WHERE app_id IS NOT NULL);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Function cho DELETE trên user_grants
CREATE OR REPLACE FUNCTION rbac.bump_epochs_from_grants_delete()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO rbac.metadata (key, value, updated_at)
  VALUES ('resolve_epoch', '1', now())
  ON CONFLICT (key) DO UPDATE SET
    value = (COALESCE(rbac.metadata.value, '0')::bigint + 1)::text,
    updated_at = now();

  UPDATE rbac.apps
     SET permission_epoch = permission_epoch + 1
   WHERE id IN (SELECT DISTINCT app_id FROM old_grants WHERE app_id IS NOT NULL);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Triggers cho user_grants — Postgres constraint: transition tables (NEW/OLD TABLE)
-- KHÔNG cho phép combine multi-event → phải split INSERT + UPDATE + DELETE thành 3 triggers riêng.
DROP TRIGGER IF EXISTS user_grants_epoch_insert ON rbac.user_grants;
CREATE TRIGGER user_grants_epoch_insert
  AFTER INSERT ON rbac.user_grants
  REFERENCING NEW TABLE AS new_grants
  FOR EACH STATEMENT EXECUTE FUNCTION rbac.bump_epochs_from_grants_upsert();

DROP TRIGGER IF EXISTS user_grants_epoch_update ON rbac.user_grants;
CREATE TRIGGER user_grants_epoch_update
  AFTER UPDATE ON rbac.user_grants
  REFERENCING NEW TABLE AS new_grants
  FOR EACH STATEMENT EXECUTE FUNCTION rbac.bump_epochs_from_grants_upsert();

DROP TRIGGER IF EXISTS user_grants_epoch_delete ON rbac.user_grants;
CREATE TRIGGER user_grants_epoch_delete
  AFTER DELETE ON rbac.user_grants
  REFERENCING OLD TABLE AS old_grants
  FOR EACH STATEMENT EXECUTE FUNCTION rbac.bump_epochs_from_grants_delete();

-- Function cho role_permissions upsert (JOIN role → app_id)
CREATE OR REPLACE FUNCTION rbac.bump_epochs_from_role_perms_upsert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO rbac.metadata (key, value, updated_at)
  VALUES ('resolve_epoch', '1', now())
  ON CONFLICT (key) DO UPDATE SET
    value = (COALESCE(rbac.metadata.value, '0')::bigint + 1)::text,
    updated_at = now();

  UPDATE rbac.apps
     SET permission_epoch = permission_epoch + 1
   WHERE id IN (
     SELECT DISTINCT r.app_id
       FROM new_perms np
       JOIN rbac.roles r ON r.key = np.role_key
      WHERE r.app_id IS NOT NULL
   );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION rbac.bump_epochs_from_role_perms_delete()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO rbac.metadata (key, value, updated_at)
  VALUES ('resolve_epoch', '1', now())
  ON CONFLICT (key) DO UPDATE SET
    value = (COALESCE(rbac.metadata.value, '0')::bigint + 1)::text,
    updated_at = now();

  UPDATE rbac.apps
     SET permission_epoch = permission_epoch + 1
   WHERE id IN (
     SELECT DISTINCT r.app_id
       FROM old_perms op
       JOIN rbac.roles r ON r.key = op.role_key
      WHERE r.app_id IS NOT NULL
   );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS role_permissions_epoch_insert ON rbac.role_permissions;
CREATE TRIGGER role_permissions_epoch_insert
  AFTER INSERT ON rbac.role_permissions
  REFERENCING NEW TABLE AS new_perms
  FOR EACH STATEMENT EXECUTE FUNCTION rbac.bump_epochs_from_role_perms_upsert();

DROP TRIGGER IF EXISTS role_permissions_epoch_update ON rbac.role_permissions;
CREATE TRIGGER role_permissions_epoch_update
  AFTER UPDATE ON rbac.role_permissions
  REFERENCING NEW TABLE AS new_perms
  FOR EACH STATEMENT EXECUTE FUNCTION rbac.bump_epochs_from_role_perms_upsert();

DROP TRIGGER IF EXISTS role_permissions_epoch_delete ON rbac.role_permissions;
CREATE TRIGGER role_permissions_epoch_delete
  AFTER DELETE ON rbac.role_permissions
  REFERENCING OLD TABLE AS old_perms
  FOR EACH STATEMENT EXECUTE FUNCTION rbac.bump_epochs_from_role_perms_delete();

-- Function cho roles hierarchy changes (parent_key/can_grant)
-- ROW-level đơn giản vì role mutations là low-volume (không bulk như user_grants)
CREATE OR REPLACE FUNCTION rbac.bump_epochs_from_roles()
RETURNS TRIGGER AS $$
DECLARE
  target_app_id UUID;
BEGIN
  INSERT INTO rbac.metadata (key, value, updated_at)
  VALUES ('resolve_epoch', '1', now())
  ON CONFLICT (key) DO UPDATE SET
    value = (COALESCE(rbac.metadata.value, '0')::bigint + 1)::text,
    updated_at = now();

  target_app_id := COALESCE(NEW.app_id, OLD.app_id);
  IF target_app_id IS NOT NULL THEN
    UPDATE rbac.apps
       SET permission_epoch = permission_epoch + 1
     WHERE id = target_app_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS roles_epoch_bump ON rbac.roles;
CREATE TRIGGER roles_epoch_bump
  AFTER INSERT OR UPDATE OR DELETE ON rbac.roles
  FOR EACH ROW EXECUTE FUNCTION rbac.bump_epochs_from_roles();

-- ============================================================================
-- 5. TRIGGER validate_role_parent_no_cycle (BEFORE INSERT/UPDATE)
-- ============================================================================
-- Cycle detection recursive walk, depth cap 10 (match resolve CTE limit).
-- RAISE EXCEPTION nếu cycle detected → transaction fail.

CREATE OR REPLACE FUNCTION rbac.validate_role_parent_no_cycle()
RETURNS TRIGGER AS $$
DECLARE
  current_key   TEXT;
  visited_keys  TEXT[];
  depth         INT := 0;
BEGIN
  -- No parent → không thể cycle
  IF NEW.parent_key IS NULL THEN
    RETURN NEW;
  END IF;

  -- Self-parent = cycle trivial
  IF NEW.parent_key = NEW.key THEN
    RAISE EXCEPTION 'cycle detected: role % cannot be its own parent', NEW.key;
  END IF;

  current_key := NEW.parent_key;
  visited_keys := ARRAY[NEW.key];

  WHILE current_key IS NOT NULL LOOP
    depth := depth + 1;
    IF depth > 10 THEN
      RAISE EXCEPTION 'role hierarchy depth exceeded 10 for role %', NEW.key;
    END IF;

    IF current_key = ANY(visited_keys) THEN
      RAISE EXCEPTION 'cycle detected in role hierarchy: % → %', NEW.key, current_key;
    END IF;

    visited_keys := visited_keys || current_key;
    SELECT parent_key INTO current_key FROM rbac.roles WHERE key = current_key;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS roles_parent_cycle_check ON rbac.roles;
CREATE TRIGGER roles_parent_cycle_check
  BEFORE INSERT OR UPDATE OF parent_key ON rbac.roles
  FOR EACH ROW EXECUTE FUNCTION rbac.validate_role_parent_no_cycle();

-- ============================================================================
-- 6. Seed system data (SAFE cho prod)
-- ============================================================================
-- Dummy app 'central' cho Central platform (mọi central.operator grant ref app này).
-- Fixed UUID để bootstrap script tham chiếu ổn định.

INSERT INTO rbac.apps (id, slug, name, created_by, client_type)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'central',
  'Central RBAC Platform',
  'system',
  'web'
)
ON CONFLICT (slug) DO NOTHING;

-- Role central.operator (system-managed, không edit qua UI)
INSERT INTO rbac.roles (key, description, parent_key, source, app_id)
VALUES (
  'central.operator',
  'Central platform operator — grants superadmin to any app, bypass can_grant.',
  NULL,
  'system',
  '00000000-0000-0000-0000-000000000001'
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 7. Record migration version
-- ============================================================================
INSERT INTO rbac.schema_migrations (version, applied_at)
VALUES (19, now())
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Reset session timeouts (không leak vào subsequent queries trong cùng session)
RESET lock_timeout;
RESET statement_timeout;
