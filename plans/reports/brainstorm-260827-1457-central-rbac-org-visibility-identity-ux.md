# Brainstorm — Central RBAC org visibility + admin identity UX

**Date**: 2026-08-27 14:57
**Context**: Session Phase 07/08 e2e discovery — user gặp confusion về cross-org projects (OneMCP Portal ở Authway Internal vs wizard-created OneMCP ở spike-test) + top-right hiện userId `387657093185798148` xấu.

## Problem statement

**Concern #2 — Org sync**: Central RBAC hiện track user's home org + project's owner org nhưng KHÔNG surface trong UI. Admin phải mò userId, projectId để đoán org. Kết quả: dễ nhầm cross-org grant → outbox dead events như session vừa rồi.

**Concern #3 — Admin identity UX**: Sidebar/header hiện Zitadel `sub` claim (long numeric id). Không có avatar, tên, dropdown Đăng xuất tường minh. Trải nghiệm không chuyên nghiệp.

## Requirements (agreed)

1. Users list column "Tổ chức" hiện home org.
2. User detail drawer badge org của user.
3. Grant dialog: giữ Project dropdown, filter roles theo project (fix bug hiện tại project select nhưng không gửi backend).
4. Header top-right: display_name + avatar initial + dropdown "Đăng xuất".
5. Lazy on-demand sync org từ Zitadel + cache Redis 5min. Không tạo table `rbac.orgs`.
6. Profile lấy từ JWT claim (`name` → `preferred_username` → `email` → `sub`). Fallback chain.

## Approaches evaluated

### Sync mechanism

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Lazy on-demand + Redis cache | KISS, không table, không cron, drift-free | N calls đầu lần load list users | **Chosen** — scale <10 orgs OK |
| Local table + manual sync button | Persistent, fast queries | Drift risk khi quên sync | Rejected — thêm complexity mà chưa cần |
| Cron 15min sync | Auto-fresh | Moving part + drift window | Rejected — YAGNI |

### Profile source

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| JWT claim | Zero backend call, có sẵn | Client-side decode | **Chosen** |
| GET /v1/me backend | Always fresh | 1 round-trip mỗi session | Rejected — overkill |

### Grant dialog fix

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Bỏ Project dropdown | Simplest | Mất context "project + role" | Rejected — user thấy roles list dài không phân biệt project |
| Giữ Project, filter role theo project | UX rõ ngữ cảnh, sửa bug hiện tại | Cần logic filter client-side | **Chosen** |

## Final design

### Phase 1 — Backend enrichment (est. 1.5h)
- `lib/zitadel-org-client.ts` **new**: `getOrgById(orgId)` + Redis cache TTL 300s.
- `routes/users.ts`: enrich list + `/v1/users/:id` với `organization: {id, name}`.
- `routes/projects.ts`: enrich với `org: {id, name}` (project owner).

### Phase 2 — Wizard writes org (est. 30min)
- `POST /v1/admin/apps`: extract `resourceOwner` từ Zitadel addProject response → INSERT `rbac.apps.zitadel_org_id` (cột đã có Migration 012).
- Backfill 1-off cho apps hiện tại (chỉ 'onemcp' đã set thủ công trong migration 012).

### Phase 3 — UI display (est. 2.5h)
- `lib/types.ts`: thêm `organization` cho user, `org` cho project.
- `hooks/use-me.ts` **new**: decode JWT, fallback chain.
- `pages/users/users-list-page.tsx`: column "Tổ chức" — hiển thị `user.organization.name` hoặc `—`.
- `pages/users/user-detail-drawer.tsx`: badge org small dưới email.
- `pages/users/grant-dialog.tsx`: Project dropdown filter roles by `role.app_id → project`. Submit disable đến khi có cả 2. Options format "OneMCP Portal · Authway Internal".
- `components/layout/sidebar.tsx` (hoặc create header): top-right avatar + name + dropdown "Đăng xuất".

## Files changed

Backend (~4):
- `src/lib/zitadel-org-client.ts` **new**
- `src/routes/users.ts`
- `src/routes/projects.ts`
- `src/routes/admin-apps.ts`

UI (~6):
- `src/lib/types.ts`
- `src/hooks/use-me.ts` **new**
- `src/pages/users/users-list-page.tsx`
- `src/pages/users/user-detail-drawer.tsx`
- `src/pages/users/grant-dialog.tsx`
- `src/components/layout/sidebar.tsx` (hoặc `layout/header.tsx` new)

## Risks + mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| N+1 Zitadel API calls list users | Latency spike lần đầu | Batch unique orgIds + Redis 5min. ~10 orgs OK. |
| Cache stale khi org rename | Hiển thị sai <5min | Chấp nhận. Rename hiếm. |
| JWT claim thiếu name/email | Header bị `sub` | Fallback chain 4 tầng. |
| Grant dialog refactor phá revoke flow | Regression | Test grant + revoke cả 2 project (spike-project + OneMCP Portal) sau code. |
| Wizard cũ (đã tạo apps) không có org_id | Grant vào app cũ fail | Migration 012 đã backfill `onemcp` app. Wizard mới ghi từ đầu. |

## Success metrics

- Users list hiện đủ org name cho tất cả user Zitadel.
- Grant dialog: chọn project → role list chỉ hiện role thuộc project đó.
- Grant Spike Tester `onemcp.admin` từ dialog mới thành công (outbox `add_or_update_user_grant` status=done).
- Header hiện "Chương" (hoặc display_name admin) thay vì userId.
- Đăng xuất từ dropdown clear session + redirect login.

## Deferred (out of scope)

- Table `rbac.orgs`: chỉ tạo khi cần org lifecycle (create/delete/rename từ Central RBAC).
- Multi-org user switcher: chỉ cần khi có admin thuộc >1 org.
- "Hồ sơ chi tiết" page + Copy user ID: thêm khi có nhu cầu debug.
- Cron sync auto: chờ scale số org > 20.

## Next steps

- Tạo plan `260827-1457-central-rbac-org-visibility-identity-ux` với 3 phase.
- Cook theo phase.
- Test regression grant/revoke sau Phase 3.
- Deploy qua tar-over-ssh + docker build.

## Unresolved questions

- Chưa quyết font/style avatar initial: matching Central RBAC gradient hay giữ đơn sắc? → decide khi làm UI.
- Sidebar logout button hiện có sẵn ở bottom — có move lên header dropdown hay giữ cả 2? → khảo sát khi làm UI, giữ nhất quán.
