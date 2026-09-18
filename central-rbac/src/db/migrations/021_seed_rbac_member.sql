-- 021_seed_rbac_member.sql — Seed rbac.member role for ownership-based authz.
--
-- Plan: 260918-0822-central-rbac-ownership-authz Phase 01.
--
-- Vấn đề: authz hiện tại chỉ có role `rbac.admin` (full quyền). Không có tier
-- trung gian cho user thường muốn tự quản lý app của mình.
--
-- Fix: seed role `rbac.member` với 2 permissions `rbac.member.read/write`.
-- Ownership resolve qua `apps.created_by` — không cần schema change bảng.
--
-- Idempotent — ON CONFLICT DO NOTHING cho phép rerun không hại.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

BEGIN;

-- ============================================================================
-- 1. Permissions
-- ============================================================================
INSERT INTO rbac.permissions (key, description) VALUES
  ('rbac.member.read',  'Member: read own apps, roles, permissions'),
  ('rbac.member.write', 'Member: CRUD own apps + roles + permissions + grants')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 2. Role (app_id NULL = system-level, source='system' — không sync sang Zitadel project)
-- ============================================================================
INSERT INTO rbac.roles (key, description, app_id, source) VALUES
  ('rbac.member', 'Central RBAC member — quản lý app do mình tạo', NULL, 'system')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 3. Role-permission mapping
-- ============================================================================
INSERT INTO rbac.role_permissions (role_key, permission_key) VALUES
  ('rbac.member', 'rbac.member.read'),
  ('rbac.member', 'rbac.member.write')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 4. Register migration
-- ============================================================================
INSERT INTO rbac.schema_migrations (version, applied_at, description)
VALUES (21, now(), 'seed rbac.member role + permissions for ownership-based authz')
ON CONFLICT (version) DO NOTHING;

COMMIT;
