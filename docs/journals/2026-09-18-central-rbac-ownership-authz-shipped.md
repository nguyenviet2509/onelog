# 2026-09-18 — Central RBAC ownership-based authz shipped

## What

- Role mới `rbac.member` + 2 permissions `rbac.member.read/write` (migration 021)
- Middleware `require-admin-or-owner.ts` — 4 factory + `isAdmin/isBreakGlass/requireMember` + `listOwnedAppsWhere` helper
- 13 route files updated với ownership authz:
  - `admin-apps.ts`: POST/GET → requireMember + owner filter; PATCH/DELETE/oidc → requireAdminOrAppOwner
  - `admin-apps-sync-manifest.ts`: 4 routes → requireAdminOrAppOwner('id')
  - `admin-app-tokens.ts`: 3 routes → requireAdminOrAppOwner('slug')
  - `roles.ts`: GET → requireMember; POST → requireMember + body.app_id check; PATCH/DELETE + role-perm → requireAdminOrRoleOwner
  - `permissions.ts`: GET → requireMember; POST → requireMember + prefix check; PATCH/DELETE → requireAdminOrPermOwner
  - `assignments.ts`: GET → requireMember; POST → requireMember + role.app_id check; DELETE → requireMember + role_keys check
  - `grants-v2.ts`: 2 routes → requireAdminOrAppOwner('slug')
  - `audit.ts` + `drift.ts`: → requireAdmin (member không xem)
  - `permissions-lookup.ts`, `projects.ts`, `user-provision-config.ts`, `users.ts`: → requireMember
- Frontend `use-permissions.ts`: thêm `isAdmin/isMember/canReadAudit/canManageApp`; `canRead/canWrite` allow member
- Sidebar hide "Audit Log" tab nếu `!canReadAudit()`
- Runbook `docs/central-rbac-member-onboarding-guide.md` + journal này

## Why

Trước: authz all-or-nothing — chỉ `rbac.admin` full quyền, non-admin user không có tier trung gian. User thường muốn tự quản lý app cho team riêng phải nhờ vietnt/kienvt can thiệp.

Sau: 3-tier authz. Member CRUD tài nguyên của app do mình tạo (owner = `apps.created_by = sub`). Role scope qua `roles.app_id`, permission scope qua naming prefix `{owner_slug}.*`. Ownership single-owner Phase 1 (KISS), co-owner để P2 nếu cần.

## How to onboard member

Xem [docs/central-rbac-member-onboarding-guide.md](../central-rbac-member-onboarding-guide.md).

## Verified

- Unit test `require-admin-or-owner.test.ts`: 35/35 pass
- TypeScript typecheck backend + frontend: pass
- Deploy central-rbac + central-rbac-ui container: healthy, không error startup
- Migration 021 applied trên VPS: `rbac.member` role + 2 permissions + mapping OK
- **P6 E2E integration test: 21/21 backend scenarios PASS** (2026-09-18 10:45) với test user `test-member@inet.vn` (sub `391255655794606084`):
  - Scenario A (member CRUD own app): 6/6 — POST /v1/admin/apps 201, PATCH own app 200, POST permission `e2etest.custom` 201, POST attach perm 201, list filter empty→1
  - Scenario B (member không đụng app khác — expect 403): 7/7 — DELETE qlts, PATCH onemcp, POST perm `qlts.foo`, POST perm `system.evil`, DELETE role qlts.admin, POST self-assign qlts.admin, PATCH legacy perm `rbac.member.read`
  - Scenario C (member không xem audit — expect 403): 3/3 — GET /v1/audit, /v1/audit/apps, /v1/drift
  - Scenario D (admin bypass ownership — verified with pre-fix admin token): 5/5 — GET apps (thấy đầy đủ 3 apps onemcp/qlts/rbac), audit, roles, drift, assignments đều 200

## Prereq đã có

- Plan `260916-1647-account-security-hardening-preprod` Phase 01 **W1.f** (backend CRUD gate + Zitadel `projectRoleCheck=true`) đã shipped 2026-09-18 09:xx
- Vietnt + kienvt đã có role `rbac.admin` trên project central-rbac (grant existed from before)

## Followups

- P2 co-owner (bảng `app_collaborators`) — chưa cần Phase 1
- P2 transfer ownership UI — hiện dùng SQL manual: `UPDATE rbac.apps SET created_by=<sub> WHERE slug=X`
- P2 audit log filter by owner cho member — Phase 1 audit admin-only
- Legacy apps (onemcp, qlts, rbac) vẫn `created_by='backfill-*'` — admin transfer khi cần
- Rate limit per-member + app quota — chưa có

## Impact on running systems

- Không impact existing vietnt/kienvt workflow — admin bypass tất cả ownership checks
- Không impact `/v1/resolve` / `/v1/webhooks/pre-token` (auth khác, không đụng middleware ownership)
- Login flow vietnt/kienvt vẫn work (đã verify 2026-09-18 sau W1.f trap fix)
- Tồn kho apps trong prod (`onemcp/qlts/rbac`) không đổi ownership — admin quản như trước

## Traps đã gặp trong quá trình

- **Zitadel `hasProjectCheck=true` trap** (W1.f Part 2): initial set nhầm `hasProjectCheck=true` → login vietnt/kienvt fail với `Errors.User.ProjectRequired` vì user's org khác project owner org (cross-org). Fix: `hasProjectCheck=false`, giữ `projectRoleCheck=true` là đủ. Đã ghi vào phase-01 W1.f trap section.
- Deploy path: `/opt/central-rbac/` là deploy dir riêng (không phải git repo). Phải `cp` từ `/opt/onelog/central-rbac/src/` sau mỗi `git pull`.
- Pre-existing test failures (14 tests trên audit-chain-concurrency, permissions-lookup, role-sync, webhook-pre-token) — drift từ Phase 3 refactor, không liên quan ownership work.
