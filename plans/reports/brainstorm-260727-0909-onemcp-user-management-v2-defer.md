# OneMCP User Management + Dept Isolation — DEFERRED to v2

**Date:** 2026-07-27
**Status:** Decision made — defer sang plan v2 SAU khi SSO (plan `260727-0843-onemcp-gitlab-sso`) ship

## Câu hỏi user

- Cần Admin UI quản lý tài khoản?
- Cross-dept restrict (Kỹ thuật ↔ MKT không share data) có hợp lý?

## Phát hiện quan trọng (grep code)

**Backend ĐÃ enforce cross-dept isolation:**
- `artifacts.service.ts:169` — `WHERE a.department_id = user.departmentId`
- `search.service.ts:191` — same
- 8/8 query trong artifacts + search filter theo dept
- `bypassDept` flag cho admin routes

**Vấn đề thật sự:**
1. `users.service.ts:22` — user mới auto-gán `depts.getDefaultId()` → mọi user hiện đang ở 1 dept (v1 pilot Kỹ thuật)
2. Không có Admin UI thay đổi dept + role user
3. Roles env-based `MAINTAINER_USERNAMES` → SSH restart khi thêm

## Kết luận

Không phải "cần build ACL" — ACL đã có. Cần **user provisioning tool** (Admin UI).

## Decision (user confirmed)

**Option A — Defer sang v2**
- SSO plan hiện tại (plan `260727-0843-onemcp-gitlab-sso`) ship trước
- Sau SSO, đo pain point thật → mới đầu tư user management UI
- Rationale: YAGNI + strong identity (SSO) là prerequisite cho meaningful admin UI

**Visibility model chốt cho v2: Hybrid per-space**
- Default dept-only (đúng như hiện tại)
- Admin đánh dấu space `visibility='cross_dept'` cho SOP/FAQ chung
- Schema `spaces.visibility` đã có sẵn (Phase 1 v1.5)
- Ví dụ: `ops-runbook`=cross_dept (Ops share cho Support khi oncall), `mkt-q4-plan`=dept

## Backlog cho plan v2 (làm sau SSO ship)

**Scope tentative:**
1. **Backend admin endpoints** (2-3 ngày)
   - `GET /api/admin/users` list + pagination
   - `PATCH /api/admin/users/:id` update dept + role + status (admin CIDR + admin role gated)
   - `POST /api/admin/users/:id/disable` soft-delete
   - Audit log per admin action
2. **Portal Admin UI** (2-3 ngày)
   - `/admin/users` — table list, filter by dept/role/status
   - Row actions: change dept, change role, disable/enable
   - `/admin/spaces/:slug/visibility` — toggle dept/cross_dept
3. **Space visibility enforce ở search + list** (1 ngày)
   - Hiện tại filter chỉ `department_id`; cần thêm: `OR space.visibility='cross_dept'`
   - Update search-artifact-filter-builder + artifacts.service.list()
4. **Migration** — không cần, schema đã đủ

**Total v2:** 5-7 ngày dev + QA

**Blockers cho v2:**
- SSO plan phải ship trước (strong identity gate)
- Xác định department seed: bao nhiêu dept? (Kỹ thuật, Ops, Support, MKT, HR, Finance...) — user confirm khi start v2

## Không phải backlog nhưng ghi chú

- Nếu SSO ship xong mà chỉ 5-10 user thực dùng cross-dept → có thể trì hoãn Admin UI vô thời hạn, SSH env-based tạm đủ
- Đo metric adoption post-SSO 2-4 tuần trước khi kick off v2

## Cross-reference

- SSO plan: `plans/260727-0843-onemcp-gitlab-sso/` (SSO only, keep env roles, no scope creep)
- Prior brainstorm: `plans/reports/brainstorm-260727-0843-onemcp-gitlab-sso.md` (audit 9 requirements + 3 approach)
- v1.5 plan (complete): `plans/260724-0821-onemcp-multidept-v1-5/`

## Open questions (bỏ ngỏ tới v2)

1. iNET có convention email dept không (`user@ops.inet.vn` hay dùng `@inet.vn` chung)? — impact auto-provision dept từ email
2. Bao nhiêu dept thật sự dùng OneMCP? — impact scope Admin UI (5 dept vs 20 dept khác nhau)
3. Có cần "dept-admin" role phụ (không phải super-admin nhưng manage user trong dept mình)? Hay chỉ super-admin?
4. User có được đổi dept của chính mình không? Hay chỉ admin?
