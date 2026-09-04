---
type: brainstorm
date: 2026-08-12 11:50
slug: authway-central-rbac
status: agreed
follow_up: /ck:plan
---

# Brainstorm — Authway Central RBAC (đóng gap vs target arch ZITADEL + RBAC)

## Problem statement

Mockup [Central Management Architecture - ZITADEL + RBAC.html](../../authway/mockups/Central%20Management%20Architecture%20-%20ZITADEL%20+%20RBAC.html) đề xuất arch 3 lớp: **ZITADEL (identity) + Central RBAC (WHO/WHAT) + per-app Resource ACL (WHERE/ALLOW-DENY)**.

Hiện Authway mới có **lớp identity (Zitadel v4.15 + IAP oauth2-proxy)**. Không có Central RBAC service, không có permission naming convention, không có RBAC claim vào app. Match target ~40%.

## Requirements

- App đầu tiên áp dụng: **OneLog** (dogfood nội bộ)
- Roadmap: **3-5 app trong 6-12 tháng** (Cloud Panel, S3 Panel, Monitoring...)
- Scope hiện tại: **Single-org** (phòng KT), evolve multi-org sau
- Permission naming chuẩn `<service>.<resource>.<action>`
- Không phá luồng identity/IAP hiện có
- YAGNI/KISS/DRY

## Đối chiếu hiện trạng vs target

| Layer target | Trạng thái | Ghi chú |
|---|---|---|
| ZITADEL Identity/SSO/MFA | ✅ Có đủ | v4.15+, Login v2, MFA policy enforce |
| OIDC/OAuth2 apps qua IAP | ✅ Có | oauth2-proxy sidecar pattern |
| User/Group/Org | ✅ Có | Zitadel Instance→Org→Project |
| Central RBAC service | ❌ Thiếu hẳn | Chỉ có Zitadel Project→Roles thô |
| Permission naming convention | ❌ Chưa có | Chỉ có user metadata convention |
| RBAC claims tới app | ❌ Thiếu | IAP header chỉ có email/user, không có roles |
| Role assignment UI | ⚠️ Manual qua Zitadel Console | Không scale |
| Per-app Resource ACL pattern | ❌ Chưa có template | |
| Audit RBAC changes | ⚠️ Partial | Zitadel audit user, không audit permission grants |

## Approaches đã cân nhắc

| # | Hướng | Effort | Match target | YAGNI OneLog | Scale N app | Chọn |
|---|---|---|---|---|---|---|
| A | Zitadel-native (Projects+Roles+Actions enrich) | 3-5 ngày | 40% | ✅ | ⚠️ | |
| B | **Standalone RBAC service (Go+PG)** | 2-3 tuần | 95% | ⚠️ Trade-off | ✅ | ✅ |
| C | Hybrid Zitadel + YAML in Git | ~1 tuần | 70% | ✅ | ✅ | |

**Chốt: Option B** — do roadmap 3-5 app rõ ràng, đầu tư service ngay tránh phải migrate C→B sau 6 tháng.

## Final solution

### Kiến trúc

```
                    ┌───────────────────────┐
                    │       ZITADEL          │
                    │   Identity / SSO / MFA │
                    │   User / Group / Org   │
                    └──────────┬─────────────┘
                               │ OIDC/OAuth2
                               ▼
                    ┌───────────────────────┐
                    │  oauth2-proxy (IAP)   │
                    └──────────┬─────────────┘
                               │ headers: email, user, sub
                               ▼
        ┌──────────────────────┼────────────────────────┐
        │                      │                        │
        ▼                      ▼                        ▼
  ┌─────────┐            ┌─────────┐              ┌─────────┐
  │ OneLog  │            │  Cloud  │              │   S3    │
  │  app    │            │  Panel  │              │  Panel  │
  └────┬────┘            └────┬────┘              └────┬────┘
       │  GET /authz/me?app=onelog                     │
       │  (once per session, cache in-mem)             │
       ▼                                               ▼
  ┌──────────────────────────────────────────────────────────┐
  │       authway-rbac  (Go + Fiber + Postgres)              │
  │  /authz/me   /roles   /permissions   /assignments        │
  │  Admin UI (Next.js) — CRUD roles/permissions/assignments │
  │  Sync users from Zitadel (webhook + periodic 5min)       │
  │  Audit log — mọi role grant/revoke                       │
  └──────────────────────────────────────────────────────────┘
```

### Permission naming spec

Format: `<service>.<resource>.<action>`

- `service` = app slug kebab: `onelog`, `cloud`, `s3`, `monitoring`
- `resource` = danh từ số ít kebab: `topic`, `alert`, `bucket`, `instance`
- `action` = CRUD chuẩn + custom: `read`, `list`, `create`, `update`, `delete`, `execute`, `silence`, `ack`, `reboot`
- Wildcard trong role definition: `onelog.*.read`, `onelog.topic.*`, `onelog.*.*`

Role OneLog seed:
```
onelog.viewer   → onelog.*.read, onelog.*.list
onelog.oncall   → inherits viewer + onelog.alert.silence, onelog.alert.ack
onelog.admin    → onelog.*.*
```

### Data model (core)

```sql
applications(id, slug, name, description)
permissions(id, name, app_id, description)
roles(id, name, app_id, org_id NULL, description)  -- org_id nullable → multi-org later
role_permissions(role_id, permission_id)
users(id, zitadel_user_id UNIQUE, email, synced_at)
groups(id, name, zitadel_group_id UNIQUE)
user_roles(user_id, role_id, scope JSONB, granted_by, granted_at)
group_roles(group_id, role_id, scope JSONB)
audit_log(id, actor_user_id, action, target_type, target_id, payload JSONB, at)
```

### Claim delivery = B2b

- App làm OIDC login qua Zitadel bình thường (không đổi luồng hiện có)
- Sau login, app gọi `GET /authz/me?app=<slug>` → trả `{user, roles, permissions[]}`
- App cache trong session (memory / signed cookie / Redis)
- Cache invalidation: Redis pub-sub channel `authway.rbac.invalidate` khi admin thay role
- Optional: SDK Go/Node helper wrap gọi `/authz/me` + middleware `RequirePermission("onelog.topic.read")`

### Per-app Resource ACL

RBAC service **không** quản resource ACL. Mỗi app tự có bảng ownership/sharing riêng:
- OneLog: `topic_members(topic_id, user_id, role)` (viewer/editor/owner ở scope topic)
- Cloud: `project_members(...)`
- S3: `bucket_acl(...)`

Enforcement pattern:
1. RBAC check trước (`onelog.topic.read`?)
2. Resource ACL check sau (user có trong `topic_members` của topic này?)

Docs + template code sẽ có example cho OneLog trước.

### Deployment

- Service `authway-rbac` deploy cạnh Zitadel trên `auth-vps` (Docker Compose)
- Postgres: dùng chung instance với Zitadel (schema riêng `authway_rbac`) — 1 backup pipeline
- Admin UI: Next.js sidecar (giống pattern Zitadel Login v2), path `/rbac/admin`, gated qua chính Zitadel + require role `authway.admin.*`
- Sync users từ Zitadel: webhook `user.created` + fallback periodic 5min

## Implementation considerations & risks

| Risk | Mức | Mitigation |
|---|---|---|
| RBAC service down → toàn bộ app mất authz | Cao | (a) Cache /authz/me trong session dài (15-30min); (b) Fallback: nếu service down → cho phép **deny-safe** với last-known-good cache; (c) HA sau (2 replica) |
| Sync user Zitadel drift | Trung | Webhook + periodic reconcile 5min, alert khi lệch |
| Permission table bloat | Thấp | Wildcard trong role definition; permission enumerate khi seed app |
| Migration khi thêm multi-org sau | Trung | Schema đã có `org_id NULL` từ đầu; scope JSONB flexible |
| App tự implement authz sai (bỏ qua permission check) | Cao | SDK middleware bắt buộc + code review checklist + integration test template |
| Circular dependency Admin UI login qua Zitadel + Zitadel down | Thấp | Admin UI có fallback CLI seed cho super-admin bootstrap |

## Success metrics & validation

- ✅ OneLog gọi `/authz/me` sau login, nhận đúng role/permission
- ✅ Middleware chặn 403 khi user thiếu permission
- ✅ Admin UI: assign `onelog.oncall` cho user → user check thấy silence được alert
- ✅ Audit log ghi role grant/revoke đầy đủ
- ✅ Permission naming convention doc merged vào `authway/docs/`
- ✅ Onboarding app thứ 2 (chọn thử với 1 sample-app) hoàn tất ≤ 1 ngày
- ✅ Load test: `/authz/me` p99 < 50ms với 500 concurrent

## Next steps

1. Ra plan chi tiết qua `/ck:plan` — expected phases:
   - Phase 1: RFC permission naming + data model (docs only, no code)
   - Phase 2: RBAC service backend (Go/Fiber) + Postgres schema + seed
   - Phase 3: Zitadel user sync (webhook + reconcile)
   - Phase 4: Admin UI (Next.js) — CRUD roles/permissions/assignments
   - Phase 5: SDK Go/Node + middleware + OneLog integration (dogfood)
   - Phase 6: Docs onboarding + sample app second integration
2. Sau Phase 5, review với team để chốt DR/backup + observability trước khi expand
3. Track migration criteria khi cần multi-org (schema đã sẵn sàng)

## Unresolved questions

1. **User sync source-of-truth** — nếu Zimbra LDAP là identity source (theo plan `260806-1504-sso-multi-app-zitadel-ldap-rollout`), RBAC service sync từ Zitadel hay LDAP thẳng? → **Đề xuất: chỉ sync từ Zitadel** (Zitadel đã federate LDAP), tránh 2 nguồn truth.
2. **Group federation** — Zitadel v4 chưa có "group" first-class rõ ràng. Có nên map `zitadel_metadata.department` → dynamic group không? → Cần khảo sát Zitadel v4 group support khi vào Phase 3.
3. **Rate limit `/authz/me`** — mỗi login 1 call, nhưng cache invalidation có thể gây spike. Chốt policy khi load test.
4. **Backup strategy** — dùng chung PG instance với Zitadel → backup Zitadel đã cover, hay tách schema riêng cần backup pipeline riêng?
5. **Ai owns Permission catalog?** — mỗi app team tự PR vào seed file, hay Authway team gatekeep? Ảnh hưởng workflow onboarding app.
