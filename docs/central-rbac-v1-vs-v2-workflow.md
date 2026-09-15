# Central RBAC — Workflow E2E v1 vs v2

So sánh workflow end-to-end giữa bản v1 (RBAC0 flat, Zitadel = source of truth) và v2
(RBAC1 hierarchy + tenant scope + delegation, Central = source of truth).

**Trạng thái**: v2 deployed 2026-09-14. v1 và v2 chạy song song. v1 sunset 2028-03-10.

Cross-reference: [plans/260910-1334-central-rbac-v2-refactor/](../plans/260910-1334-central-rbac-v2-refactor/) · [central-rbac-app-onboarding.md](central-rbac-app-onboarding.md) · [central-rbac-operator-runbook.md](central-rbac-operator-runbook.md)

---

## 4 workflow chính

- **A. Register app mới** — provisioning Zitadel project + Central roles
- **B. Grant user role** — cấp quyền cho user (có/không tenant)
- **C. Runtime authz check** — hot path app kiểm tra permission mỗi request
- **D. Revoke user** — thu hồi quyền khẩn cấp

---

## A. Register app mới

### v1 (flat)

```
1. Admin login Central UI
2. Fill form: name, slug, callback URL, manifest URL
3. Central → Zitadel Mgmt API: AddProject + AddOIDCApp
4. Sync manifest → INSERT rbac.permissions (flat list)
5. Manual create roles: mỗi role = list permission_ids (không có parent)
6. Return client_id + client_secret
```

### v2 (hierarchy + tenant)

```
1-3. Giống v1 (Zitadel provisioning không đổi)
4. Sync manifest v2 → INSERT rbac.permissions
   + INSERT rbac.roles với parent_key + can_grant + tenant_aware
5. Wizard AUTO tạo 4 default roles: viewer → member → admin → superadmin
   (chain qua parent_key, mỗi role inherit permission cha)
   → Skip nếu manifest có default_roles hoặc skip_default_roles=true
6. Return client_id + client_secret
```

### Khác biệt

- v2 auto-provision 4-role hierarchy (admin không cần config thủ công)
- Manifest v2 có `tenant_aware` + `tenant_lookup_url` (v1 không có concept tenant)
- Cột mới `apps.permission_epoch` (bump khi role/permission thay đổi)

---

## B. Grant user role

### v1

```
Admin → Central UI → chọn user + app + role
  ↓
Central → Zitadel Mgmt API: UserGrant.Add(user, project, roleKey)
  ↓
Zitadel lưu grant = source of truth
  ↓
Central KHÔNG lưu grant local (chỉ mirror qua audit_log)
```

### v2

```
Admin → Central UI → chọn user + app + role + tenant_id (optional)
  ↓
Central check delegation: grantor có role với can_grant chứa target không?
  (BEGIN + SELECT FOR UPDATE lock chống race window)
  ↓
INSERT rbac.user_grants (user_sub, app_id, role_key, tenant_id) ← SOURCE OF TRUTH
  ↓
Enqueue outbox → async worker → Zitadel Mgmt API:
  - Expand hierarchy: role_key + tất cả role ancestor
  - PUT UserGrant với full expanded role list
  ↓
Zitadel = MIRROR (cho JWT claim, KHÔNG phải authz source)
```

### Khác biệt lớn

| Concern | v1 | v2 |
|---|---|---|
| Source of truth | Zitadel | Central `rbac.user_grants` |
| Delegation check | Không (admin toàn quyền) | can_grant per-role, lock chống race |
| Tenant scope | Không có | Có — cùng user, tenant khác → role khác |
| Zitadel role list | 1 role key | Full expanded ancestors (backward-compat apps v1) |

---

## C. Runtime authz check (hot path)

### v1 — 2 pattern song song

**Pattern 1 — App tự đọc JWT**:
```
User → App → verify JWT (Zitadel JWKS) → parse roles claim
  ↓
Check role trong whitelist hard-coded → allow/deny
```

**Pattern 2 — App call Central `/v1/resolve`**:
```
User → App → POST /v1/resolve (X-Rbac-Token) với {user_sub, app_slug}
  ↓
Central query: user roles từ Zitadel introspect + join rbac.roles
  ↓
Return list permissions flat
  ↓
App check permission trong list
```

### v2 — App dùng SDK

```
User → App route handler
  ↓
SDK preHandler: requirePermission('helpdesk:tickets.list', { tenantIdFrom: 'query.dept' })
  ↓
SDK check LRU cache key = (user_sub, tenant_id, epoch)
  ↓ cache miss
SDK POST /v2/resolve {user_sub, app_slug, tenant_id}
  ↓
Central:
  1. Verify X-Rbac-Token
  2. Scope check: user có grant nào trong app không? (nếu không → empty response, không leak)
  3. Recursive CTE expand hierarchy: role + ancestors (depth cap 10)
  4. Filter tenant: (tenant_id match) OR (tenant_id NULL = global)
  5. Join permissions → return list + current epoch
  ↓
SDK cache 60s, background poll /v2/epoch/:app_slug mỗi 10s
  → nếu epoch bump → invalidate cache
  ↓
SDK check permission trong list → allow/deny
```

### Khác biệt

| Concern | v1 | v2 |
|---|---|---|
| Boilerplate app dev | ~300 LOC/app | ~30 LOC (SDK) |
| Cache invalidation | TTL naive (5-15 phút) | Epoch-based (<10s) |
| Tenant scope | Không | Có |
| Circuit breaker | Tự viết | Built-in 3-state |
| Fail-close prod | Tự app quyết định | SDK hardcoded reject `failMode=open` khi NODE_ENV=production |
| Scope leak | Có thể leak permissions khi user không thuộc app | Empty response — no leak |

---

## D. Revoke user (khẩn cấp)

### v1

```
Admin → Central UI → click Revoke
  ↓
Central → Zitadel Mgmt API: UserGrant.Remove
  ↓
App vẫn cho user access cho tới khi JWT expire (default 12h)
  ↓ hoặc
App poll Central /v1/resolve → thấy roles empty → deny
  (nhưng nếu app cache mạnh → 5-15 phút mới thấy)
```

### v2

```
Admin → Central UI → click Revoke
  ↓
Central:
  - DELETE rbac.user_grants (WHERE grant_id=$1)
  - Bump apps.permission_epoch (STATEMENT-level trigger, dual-bump global + per-app)
  - Enqueue outbox notify_app_revoke → app webhook
  - Enqueue outbox Zitadel UserGrant.Remove
  ↓
Song song 2 nhánh:

  A. Epoch bump path (best-effort <10s):
     SDK poll epoch → thấy bump → invalidate cache
     → next request re-resolve → empty roles → deny

  B. Webhook path (immediate <1s):
     App webhook /rbac/notify-revoke nhận signal
     → xóa session ngay lập tức
```

### Khác biệt

| Concern | v1 | v2 |
|---|---|---|
| Emergency revoke | JWT expire 12h | Webhook <1s + epoch bump <10s |
| Audit tamper detection | Không | Hash chain (application-level SHA256) |

---

## Sơ đồ tổng thể

### v1

```
                  ┌─────────┐
       User ─────►│   App   │──verify JWT──► Zitadel (source of truth)
                  │         │──/v1/resolve─► Central
                  └─────────┘                  │
                                               └─► Postgres
                                                   (rbac.permissions, rbac.roles)
```

### v2

```
                  ┌─────────┐
       User ─────►│   App   │
                  │  + SDK  │──/v2/resolve──► Central ─────► Postgres
                  │         │◄─notify-revoke──   │           (+ user_grants
                  └─────────┘                    │              + tenant_id
                                                 │              + hierarchy)
                                                 │
                                                 └─outbox──► Zitadel (mirror only)
                                                              │
                     verify JWT (aud/iss/sig) ◄───────────────┘
                     (KHÔNG dùng roles claim làm authz source)
```

---

## Bảng so sánh nhanh

| Concern | v1 | v2 |
|---|---|---|
| Source of truth grants | Zitadel | Central (`rbac.user_grants`) |
| Role model | Flat | Hierarchy (`parent_key`) |
| Delegation | Admin toàn quyền | `can_grant` per-role |
| Tenant scope | Không | Có (opaque `tenant_id`) |
| Cache invalidation | TTL naive | Epoch-based, ~10s |
| Emergency revoke | JWT expire 12h | Webhook <1s + epoch bump 10s |
| Audit tamper detection | Không | Hash chain |
| App dev boilerplate | ~300 LOC/app | ~30 LOC (SDK) |
| Onboarding time app mới | ~1 tuần | <4h target |
| Backward compat | — | v1 endpoints giữ tới 2028-03-10 |

---

## v1 và v2 song song

- Apps cũ (`qlts`, `onemcp`) vẫn dùng `/v1/resolve` — không đổi gì
- Apps mới → dùng SDK + `/v2/resolve`
- Cùng 1 Central instance serve cả 2 endpoint
- Response header `X-Api-Version: 1|2` để trace
- Timeline: v1 deprecated warning `2027-09-10`, sunset `2028-03-10`

---

## Related docs

- [App onboarding (5-step)](central-rbac-app-onboarding.md)
- [Manifest v1→v2 migration guide](central-rbac-manifest-v2-migration.md)
- [Operator runbook](central-rbac-operator-runbook.md)
- [Plan v2 refactor](../plans/260910-1334-central-rbac-v2-refactor/plan.md)
