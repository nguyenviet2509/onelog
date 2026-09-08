-- =============================================================================
-- Migration 016: rbac.roles.source column + qlts permissions bootstrap
--
-- Adds `source` column (manual|manifest) to `rbac.roles` so FE can distinguish
-- admin-created roles (editable) from manifest-imported ones (read-only).
--
-- Seeds 91 permission keys for the qlts (quan-ly-thiet-bi-inet) app based on
-- `@Permission()` decorators found in the qlts backend (see scout report:
--   plans/reports/scout-260908-2017-qlts-permission-catalog.md).
--
-- Backfills the 3 existing Zitadel qlts roles (qlts.admin/editor/viewer) that
-- were created by the Phase 07 wizard, marking them as `manifest` source so the
-- upcoming role-CRUD UI treats them as read-only (source of truth = manifest).
--
-- Idempotent: safe to re-run.
-- =============================================================================

BEGIN;

-- ─── 1. Add source column ────────────────────────────────────────────────────
ALTER TABLE rbac.roles
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'manifest'));

COMMENT ON COLUMN rbac.roles.source IS
  'manual = admin created via Central UI, editable. manifest = imported from app manifest (default_roles), read-only in UI.';

-- ─── 2. Seed 91 qlts permissions ─────────────────────────────────────────────
-- Grouped by module for readability. Descriptions in Vietnamese to match
-- portal locale.

INSERT INTO rbac.permissions (key, description) VALUES
  -- assets (7)
  ('qlts.assets.read',       'Xem thiết bị'),
  ('qlts.assets.create',     'Tạo thiết bị'),
  ('qlts.assets.update',     'Sửa thiết bị'),
  ('qlts.assets.delete',     'Xoá thiết bị'),
  ('qlts.assets.export',     'Xuất thiết bị'),
  ('qlts.assets.checkout',   'Cấp phát thiết bị'),
  ('qlts.assets.checkin',    'Thu hồi thiết bị'),
  -- accessories (7)
  ('qlts.accessories.read',     'Xem phụ kiện'),
  ('qlts.accessories.create',   'Tạo phụ kiện'),
  ('qlts.accessories.update',   'Sửa phụ kiện'),
  ('qlts.accessories.delete',   'Xoá phụ kiện'),
  ('qlts.accessories.export',   'Xuất phụ kiện'),
  ('qlts.accessories.checkout', 'Cấp phát phụ kiện'),
  ('qlts.accessories.checkin',  'Thu hồi phụ kiện'),
  -- softwares (8, including reveal)
  ('qlts.softwares.read',     'Xem phần mềm'),
  ('qlts.softwares.create',   'Tạo phần mềm'),
  ('qlts.softwares.update',   'Sửa phần mềm'),
  ('qlts.softwares.delete',   'Xoá phần mềm'),
  ('qlts.softwares.export',   'Xuất phần mềm'),
  ('qlts.softwares.checkout', 'Cấp phát phần mềm'),
  ('qlts.softwares.checkin',  'Thu hồi phần mềm'),
  ('qlts.softwares.reveal',   'Xem license key phần mềm (giải mã)'),
  -- racks (4)
  ('qlts.racks.read',   'Xem tủ rack'),
  ('qlts.racks.create', 'Tạo tủ rack'),
  ('qlts.racks.update', 'Sửa tủ rack (bao gồm mount/unmount thiết bị)'),
  ('qlts.racks.delete', 'Xoá tủ rack'),
  -- requests (5, including approve)
  ('qlts.requests.read',    'Xem yêu cầu'),
  ('qlts.requests.create',  'Tạo yêu cầu'),
  ('qlts.requests.update',  'Sửa yêu cầu'),
  ('qlts.requests.delete',  'Xoá yêu cầu'),
  ('qlts.requests.approve', 'Duyệt yêu cầu'),
  -- journal (3, no update)
  ('qlts.journal.read',   'Xem nhật ký'),
  ('qlts.journal.create', 'Ghi nhật ký'),
  ('qlts.journal.delete', 'Xoá ghi chú nhật ký'),
  -- dashboard (1)
  ('qlts.dashboard.read', 'Xem dashboard tổng quan'),
  -- activity-logs (1)
  ('qlts.activity-logs.read', 'Xem lịch sử hoạt động'),
  -- users (4)
  ('qlts.users.read',   'Xem người dùng'),
  ('qlts.users.create', 'Tạo người dùng'),
  ('qlts.users.update', 'Sửa người dùng'),
  ('qlts.users.delete', 'Xoá người dùng'),
  -- object-permissions (2; create/delete are @Superuser only, not grantable)
  ('qlts.object-permissions.read',   'Xem bộ quyền'),
  ('qlts.object-permissions.update', 'Sửa bộ quyền'),
  -- user-groups (1; writes are @Superuser only)
  ('qlts.user-groups.read', 'Xem nhóm người dùng'),
  -- companies (4)
  ('qlts.companies.read',   'Xem công ty'),
  ('qlts.companies.create', 'Tạo công ty'),
  ('qlts.companies.update', 'Sửa công ty'),
  ('qlts.companies.delete', 'Xoá công ty'),
  -- regions (4)
  ('qlts.regions.read',   'Xem khu vực'),
  ('qlts.regions.create', 'Tạo khu vực'),
  ('qlts.regions.update', 'Sửa khu vực'),
  ('qlts.regions.delete', 'Xoá khu vực'),
  -- branch-groups (4)
  ('qlts.branch-groups.read',   'Xem nhóm chi nhánh'),
  ('qlts.branch-groups.create', 'Tạo nhóm chi nhánh'),
  ('qlts.branch-groups.update', 'Sửa nhóm chi nhánh'),
  ('qlts.branch-groups.delete', 'Xoá nhóm chi nhánh'),
  -- branches (4)
  ('qlts.branches.read',   'Xem chi nhánh'),
  ('qlts.branches.create', 'Tạo chi nhánh'),
  ('qlts.branches.update', 'Sửa chi nhánh'),
  ('qlts.branches.delete', 'Xoá chi nhánh'),
  -- departments (4)
  ('qlts.departments.read',   'Xem phòng ban'),
  ('qlts.departments.create', 'Tạo phòng ban'),
  ('qlts.departments.update', 'Sửa phòng ban'),
  ('qlts.departments.delete', 'Xoá phòng ban'),
  -- employees (4)
  ('qlts.employees.read',   'Xem nhân viên'),
  ('qlts.employees.create', 'Tạo nhân viên'),
  ('qlts.employees.update', 'Sửa nhân viên'),
  ('qlts.employees.delete', 'Xoá nhân viên'),
  -- suppliers (4)
  ('qlts.suppliers.read',   'Xem nhà cung cấp'),
  ('qlts.suppliers.create', 'Tạo nhà cung cấp'),
  ('qlts.suppliers.update', 'Sửa nhà cung cấp'),
  ('qlts.suppliers.delete', 'Xoá nhà cung cấp'),
  -- manufacturers (4)
  ('qlts.manufacturers.read',   'Xem hãng sản xuất'),
  ('qlts.manufacturers.create', 'Tạo hãng sản xuất'),
  ('qlts.manufacturers.update', 'Sửa hãng sản xuất'),
  ('qlts.manufacturers.delete', 'Xoá hãng sản xuất'),
  -- categories (4)
  ('qlts.categories.read',   'Xem danh mục'),
  ('qlts.categories.create', 'Tạo danh mục'),
  ('qlts.categories.update', 'Sửa danh mục'),
  ('qlts.categories.delete', 'Xoá danh mục'),
  -- asset-models (4)
  ('qlts.asset-models.read',   'Xem kiểu thiết bị'),
  ('qlts.asset-models.create', 'Tạo kiểu thiết bị'),
  ('qlts.asset-models.update', 'Sửa kiểu thiết bị'),
  ('qlts.asset-models.delete', 'Xoá kiểu thiết bị'),
  -- asset-roles (4)
  ('qlts.asset-roles.read',   'Xem vai trò thiết bị'),
  ('qlts.asset-roles.create', 'Tạo vai trò thiết bị'),
  ('qlts.asset-roles.update', 'Sửa vai trò thiết bị'),
  ('qlts.asset-roles.delete', 'Xoá vai trò thiết bị'),
  -- statuses (4)
  ('qlts.statuses.read',   'Xem trạng thái'),
  ('qlts.statuses.create', 'Tạo trạng thái'),
  ('qlts.statuses.update', 'Sửa trạng thái'),
  ('qlts.statuses.delete', 'Xoá trạng thái')
ON CONFLICT (key) DO NOTHING;

-- ─── 3. Backfill 3 existing qlts roles as manifest-origin ────────────────────
-- These already exist in Zitadel (created by Phase 07 wizard default set) and
-- in rbac.roles (imported). Mark them source='manifest' so admin can't edit
-- them via UI — future changes should flow through app manifest → sync.
UPDATE rbac.roles
   SET source = 'manifest'
 WHERE key IN ('qlts.admin', 'qlts.editor', 'qlts.viewer');

-- ─── 4. Record migration ─────────────────────────────────────────────────────
INSERT INTO rbac.schema_migrations (version, description) VALUES
  (16, 'rbac.roles.source column + qlts 91 permissions seed + 3 existing role backfill as manifest')
ON CONFLICT (version) DO NOTHING;

COMMIT;
