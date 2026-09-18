# Central RBAC — Onboarding member mới

Runbook cho admin (vietnt/kienvt) khi cấp quyền cho user mới sử dụng Central RBAC UI.

**Plan ref:** [plans/260918-0822-central-rbac-ownership-authz/plan.md](../plans/260918-0822-central-rbac-ownership-authz/plan.md)

## Vai trò (2 tiers)

| Role | Read | Write own | User mgmt (create/delete/deactivate) | Audit |
|---|---|---|---|---|
| `rbac.admin` (hoặc `system.root`) | ✅ all | ✅ any app | ✅ | ✅ (own app: member owner cũng xem được — plan 260918-1308 Phase 03) |
| `rbac.member` | ✅ scoped (own apps) | ✅ own app | ❌ | ✅ own app only |
| Không grant | ❌ Không login được (Zitadel `projectRoleCheck=true` reject) | | | |

> **Note (2026-09-18):** `rbac.viewer` đã được drop trong plan `260918-1308-central-rbac-authz-full-cleanup` Phase 01 — YAGNI, chưa ai được grant + scope trùng member.

## One-time setup (chỉ chạy 1 lần cho instance)

Role `rbac.member` phải tồn tại **cả** trong Central RBAC DB (migration 021) **và** Zitadel project `central-rbac` (grant Zitadel yêu cầu role tồn tại trên project).

Migration 021 chỉ seed vào Central DB. Bootstrap Zitadel role qua Mgmt API 1 lần:

```bash
ssh authway-vps
PAT=$(grep '^ZITADEL_SA_PAT=' /opt/central-rbac/.env | cut -d= -f2)
curl -sS -X POST 'https://zitadel.000nethost.com/management/v1/projects/387779900762750980/roles' \
  -H "Authorization: Bearer $PAT" \
  -H 'x-zitadel-orgid: 387656897144029188' \
  -H 'Content-Type: application/json' \
  -d '{"roleKey":"rbac.member","displayName":"RBAC Member","group":""}'
```

Idempotent — chạy lại trả `AlreadyExists` (409), không hại. Đã chạy 2026-09-18.

## Onboarding 1 member mới — 3 bước

### Bước 1 — User đã tồn tại trong Zitadel

- User đã có tài khoản Zitadel (email `@inet.vn` hoặc org khác)
- Nếu chưa có → Zitadel Console → Users → **+ New Human**

### Bước 2 — Grant role `rbac.member` cho user

Login `https://rbacnb.000nethost.com/` bằng admin →
- Tab **Người dùng** → search email
- Click **Grant** → chọn app **Central RBAC** → chọn role **rbac.member** → Confirm

Đợi ~30s cho grant propagate qua Zitadel → Central RBAC pre-token cache.

### Bước 3 — User verify login

User → incognito browser → `https://rbacnb.000nethost.com/` → login →
- Land `/apps` với empty state "Chưa có project nào..." + CTA "+ App mới"

## Ownership cheat sheet

| Action | Admin | Member (owner) | Member (not owner) |
|---|---|---|---|
| Tạo app mới | ✅ | ✅ (tự thành owner) | ✅ |
| Sửa/xoá app | ✅ | ✅ | ❌ 403 |
| Xem app trong list | ✅ tất cả | ✅ chỉ own | ❌ ẩn khỏi list |
| Tạo permission `{owner_slug}.*` | ✅ | ✅ | ❌ 403 |
| Sửa/xoá role app mình | ✅ | ✅ | ❌ 403 |
| Grant role app mình cho user khác | ✅ | ✅ | ❌ 403 |
| **Tạo/xoá/vô hiệu hoá user** | ✅ | ❌ button hidden + 403 | ❌ |
| Xem audit log (own app) | ✅ tất cả | ✅ own app only | ❌ 403 |
| Xem audit log (cross-app) | ✅ | ❌ | ❌ |

## Gotcha

- **LUÔN grant qua UI rbacnb (`/v1/assignments`)** — KHÔNG grant qua Zitadel Console/API trực tiếp. Central RBAC có 2 grant sources phải sync (Zitadel `user_grants5` + Central `rbac.user_grants` direct-grants filter). UI/API tự sync cả 2. Grant qua Zitadel API trực tiếp → drift → UI drawer báo "Chưa có quyền" mặc dù JWT có role. Fix drift qua SQL:
  ```sql
  UPDATE rbac.user_grants SET role_key='rbac.member'
    WHERE user_sub='<user_sub>' AND role_key='<old_role>';
  ```
  + bust Redis cache: `DEL user-detail:v1:<user_sub>` + `DEL assignments:v1:<user_sub>`
- **Cache lag 5min:** sau khi grant `rbac.member`, user login ngay có thể vẫn 403 do pre-token webhook cache. Đợi 30s hoặc logout/login lại.
- **Legacy apps** (onemcp, qlts, rbac) có `apps.created_by='backfill-*'` → không member nào own. Admin muốn cho member quản lý → SQL manual update:
  ```sql
  UPDATE rbac.apps SET created_by = '<user_sub>' WHERE slug = 'onemcp';
  ```
- **Zitadel grant ≠ Central manage:** grant role `myapp.admin` cho user Y = Y **dùng được** app đó (backend nhận JWT roles). KHÔNG cho Y quyền quản lý metadata app trong Central UI.

## Revoke member

Admin → tab **Người dùng** → tìm user → Revoke role `rbac.member`. User next login sẽ 403 login (Zitadel refuse token cho project không grant).

**LƯU Ý:** Revoke `rbac.member` KHÔNG xoá apps user đã tạo (vẫn giữ `created_by=<sub>`). Muốn transfer ownership → SQL manual hoặc plan tương lai add UI.

## Troubleshooting

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| User login → "Bạn không có quyền truy cập trang này" | Chưa grant `rbac.member` | Grant qua UI |
| User login → Zitadel `Unknown error occurred` / `ProjectRequired` | Chưa grant bất kỳ role nào trên project central-rbac | Grant tối thiểu `rbac.member` |
| Member 403 khi tạo permission `foo.bar` | Slug `foo` không phải app member own | Verify member đã tạo app slug `foo` trước |
| Member không thấy app vừa tạo | Cache SPA hoặc router chưa refresh | F5 page |
| Grant role `myapp.admin` cho user khác → 403 | Role thuộc app không owned by grantor | Verify grantor là creator của `myapp` |
| Member truy cập `/audit` trực tiếp | Backend 403; tab đã ẩn ở sidebar | Bình thường — audit admin-only |

## Cross-reference

- Backend middleware: [central-rbac/src/middleware/require-admin-or-owner.ts](../central-rbac/src/middleware/require-admin-or-owner.ts)
- Frontend helpers: [central-rbac-ui/src/hooks/use-permissions.ts](../central-rbac-ui/src/hooks/use-permissions.ts)
- Migration: [central-rbac/src/db/migrations/021_seed_rbac_member.sql](../central-rbac/src/db/migrations/021_seed_rbac_member.sql)
- Prereq: [Hardening plan 260916-1647 Phase 01 W1.f](../plans/260916-1647-account-security-hardening-preprod/phase-01-wave1-blocker.md)
- Brainstorm design: [plans/reports/brainstorm-260918-0822-central-rbac-ownership-authz.md](../plans/reports/brainstorm-260918-0822-central-rbac-ownership-authz.md)
