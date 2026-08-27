# 2026-08-27 — Central RBAC cross-org grants + org visibility + admin identity UX

Extended session sau Phase 07/08 e2e fix. 3 vấn đề lớn phát hiện + fix, kèm plan 260827-1457 cho org visibility + admin identity UX được cook trọn vẹn.

## Bối cảnh

- Session trước fix xong Multi-project awareness (Migration 011) và Grant flow bugs (grant.id undefined, empty-grant, idem swallow).
- User Spike Tester được cấp grant onemcp.admin trên project wizard-created (388071945217769476) → login OneMCP portal fail `Errors.User.GrantRequired`.
- Root cause: OneMCP portal thật đăng nhập qua project `385595003772076035` (owner Authway Internal org), khác với project wizard-created (owner spike-test).

## Cross-org architectural fix

**Migration 012** thêm `apps.zitadel_org_id` để track project OWNER org.

**Backfill state**:
- DELETE row rbac.apps 'onemcp' cũ (wizard project).
- INSERT row rbac.apps 'onemcp' mới trỏ project portal `385595003772076035` với `zitadel_org_id = 385591139173990404`.
- Relink 3 roles onemcp.viewer/editor/admin sang app_id mới.
- Enqueue add_project_role (3 roles) trên project portal → outbox worker tạo trong Zitadel.
- Revoke Spike Tester's wizard-project grant qua Zitadel Management API DELETE.
- Regrant Spike Tester onemcp.admin qua enqueue outbox với orgId đúng.

**Backend cross-org support**:
- `services/user-grant-sync.ts` — thay `resolveProjectIdForRole` bằng `resolveProjectContextForRole` return `{projectId, orgId}` từ apps table. Legacy fallback env.
- Thêm `listUserGrantsAllOrgs(userId)` iterate distinct orgs từ apps + env, dedup grantId.
- `removeRoleFromUser` dùng `listUserGrantsAllOrgs` để tìm grant + resolve owner org từ project.
- `getUserGrants` proxy tới `listUserGrantsAllOrgs`.
- `routes/users.ts` `/v1/users/:id` dùng `listUserGrantsAllOrgs` → drawer hiện đủ grants cross-org.

**Verified**: Zitadel side spike-user@spike-test.local có grant `onemcp.admin` trên project OneMCP Portal (Authway Internal org) via SA admin scope, cross-org.

## Auth.js/NextAuth PKCE issue (deferred)

Sau khi fix RBAC layer, login OneMCP portal fail lỗi `Configuration` — Auth.js `InvalidCheck: pkceCodeVerifier value could not be parsed`. Không phải RBAC bug, do cookie state stale từ nhiều lần retry trước fix. Solution: clean incognito flow. AUTH_SECRET stable (44 chars), config Auth.js OK.

## Plan 260827-1457: org visibility + admin identity UX

Sau khi user báo 3 concerns: (1) không thấy org info, (2) header hiện userId thô, (3) grant dialog project dropdown không filter role, brainstorm → plan → cook.

### Phase 01 — Backend lazy org enrichment

- **New** `lib/zitadel-org-client.ts`: `getOrgById` + `getOrgsBatch`, Redis cache TTL 300s.
- **Extend** `lib/zitadel-http.ts` thêm `mgmtGet` (chỉ có POST/PUT/DELETE).
- **Extend** `zitadel-user-search-client.ts` extract `details.resourceOwner` = user's home org.
- **Enrich** `routes/users.ts` list + detail: `organization: {id, name}` cho mỗi user.
- **Rewrite** `routes/projects.ts` — thay MVP hardcoded env project bằng query `rbac.apps`, enrich `org: {id, name}` per project. Legacy fallback env-only khi apps rỗng.
- **Extend** `db/queries/roles.ts listRoles`: SELECT + return `app_id` (Migration 011).

### Phase 02 — Wizard writes org

- `routes/admin-apps.ts insertApp` thêm param `zitadelOrgId`, SQL insert cột mới.
- Wizard dùng env `ZITADEL_ORG_ID` làm project owner (SA always operates trong home org).

### Phase 03 — UI display

- **New** `hooks/use-me.ts`: dùng `userManager.getUser().profile` từ `oidc-client-ts`, fallback chain `name → preferred_username → email → sub-short`.
- `lib/types.ts` thêm `Organization`, `Project.org`, `Role.app_id`, `ZitadelUser.organization`.
- `users-list-page.tsx` column "Tổ chức" render `org.name`.
- `user-detail-drawer.tsx` badge "Tổ chức: {name}" dưới email.
- `grant-dialog.tsx` refactor: Project dropdown hiện "Project · Org", chọn project → filter roles theo `app_id`. Submit disable khi thiếu project hoặc role. Legacy option "Legacy / global" hiện roles có `app_id NULL`.
- `components/layout/header.tsx` — profile menu: avatar initial + display name + dropdown "Đăng xuất". Click outside auto-close.

## Files

Backend (~7): zitadel-http.ts, zitadel-org-client.ts (new), zitadel-user-search-client.ts, db/queries/roles.ts, routes/users.ts, routes/projects.ts, routes/admin-apps.ts, services/user-grant-sync.ts.

UI (~6): lib/types.ts, hooks/use-me.ts (new), users-list-page, user-detail-drawer, grant-dialog, layout/header.

## Deployed state

- authway-vps `/opt/central-rbac` — Migration 012 applied, backend + UI rebuilt + healthy.
- Zitadel: Spike Tester có 1 grant OneMCP Portal onemcp.admin (cross-org, granted by SA).
- Central RBAC UI: hiển thị org name khắp nơi user-visible, header có profile menu.
- Grant dialog: project→role filter hoạt động đúng, không còn "project chọn nhưng không gửi backend".

## Bài học

- **Zitadel v4 cross-org grants** cần `x-zitadel-orgid` = project owner org (không phải user's org). SA có admin scope thì có thể tạo cross-org grant trực tiếp mà không cần Project Grant intermediary.
- **Migration 011 chỉ giải quyết projectId routing**, không cover orgId. Migration 012 hoàn tất pattern (project + org đều theo app).
- **Wizard tạo project mới ≠ portal thật đang chạy**. Nếu portal đã existed trước Central RBAC, phải backfill INSERT rbac.apps trỏ project cũ + relink roles + regrant users, không tạo project mới song song.
- **UI type mismatch backend response** (grant.id vs grant_id) không được TypeScript bắt vì backend response typed `any`. Cần integration test hoặc contract test.
- **oidc-client-ts profile claims** đủ cho identity UX — không cần tạo `/v1/me` endpoint nếu chỉ cần display name.

## Follow-ups

- Integration test grant→revoke→re-grant cycle ở CI (regression cover).
- Migration 008a version=81 typo cleanup.
- Wizard support multi-org creation (chọn org khi tạo app) — YAGNI trong dev, cần khi có admin cross-org thật.
- OneMCP portal Auth.js debug nếu user login vẫn fail sau clean incognito.
- Cleanup wizard-created OneMCP project (388071945217769476) ở Zitadel (orphan sau backfill).
