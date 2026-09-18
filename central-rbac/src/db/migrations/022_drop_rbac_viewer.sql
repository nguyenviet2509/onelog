-- 022_drop_rbac_viewer.sql — Drop rbac.viewer role (Y1 authz cleanup)
--
-- Model shift: 3-tier admin/member/viewer → 2-tier admin/member.
-- Viewer scope trùng member (created_by=$sub filter) → gần như vô dụng, YAGNI.
-- Zitadel projectRoleCheck=true vẫn reject login user không grant → chỉ admin/member login.
--
-- Idempotent + fail-safe: abort nếu còn grant nào giữ rbac.viewer.
--
-- Plan: 260918-1308-central-rbac-authz-full-cleanup Phase 01

BEGIN;

-- Fail-safe: abort nếu vẫn còn user grant rbac.viewer trong Central
DO $$
DECLARE cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM rbac.user_grants WHERE role_key = 'rbac.viewer';
  IF cnt > 0 THEN
    RAISE EXCEPTION 'rbac.viewer still has % grant(s); revoke tất cả trước khi drop', cnt;
  END IF;
END $$;

-- Drop role-permission mappings (nếu có seed permissions cho viewer)
DELETE FROM rbac.role_permissions WHERE role_key = 'rbac.viewer';

-- Drop role
DELETE FROM rbac.roles WHERE key = 'rbac.viewer';

COMMIT;
