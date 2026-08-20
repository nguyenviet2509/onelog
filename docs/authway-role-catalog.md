# Authway (Zitadel) — Role Catalog & App Mapping

Contract giữa **Zitadel role assignments** (WHO có role gì) và **app-level authz** (role đó cho quyền gì trong từng app).

Zitadel = identity + role source of truth. Mapping từ Zitadel role → app native role sống ở **app config** (JMESPath / env / config file). Doc này là **contract chính thức** — sửa Zitadel role catalog → sửa app config → update doc.

## Naming rule

- Role key Zitadel: **lowercase, snake_case, ASCII, ≤32 char**
- Case-sensitive khi map — `admin` khác `Admin`. Giữ nguyên lowercase.
- Không dùng wildcard trong role key (Zitadel không support, mapping app phải rõ ràng)
- Role deprecated: đánh dấu trong doc, giữ 30 ngày để migrate grant, xoá sau

## Project role catalogs

### Project `OneLog` (id `385600666015367171`)

| Role key | Display name | Group | Ý nghĩa | Áp dụng cho app |
|---|---|---|---|---|
| `admin` | admin | admin | Full admin quyền OneLog | Grafana → GrafanaAdmin (server), OpenWebUI → admin |
| `ops` | Operations | onelog | On-call, silence alert, edit dashboard | Grafana → Editor, OpenWebUI → group `ops` |
| `sale` | Sale | sales | Read-only + KB truy cập | Grafana → Viewer, OpenWebUI → group `sale` |
| `user` | User | onelog | Default employee, read-only cơ bản *(chưa tạo — thêm khi cần)* | Grafana → Viewer, OpenWebUI → user |

### Project `OneMCP Portal` (id `385595003772076035`)

| Role key | Display name | Group | Ý nghĩa | Áp dụng cho app |
|---|---|---|---|---|
| `admin` *(chưa tạo)* | Portal Admin | onemcp | Full quyền portal (users, projects, connectors) | OneMCP portal + backend |
| `editor` *(chưa tạo)* | Editor | onemcp | Tạo/edit project, connector, KB | OneMCP portal |
| `viewer` *(chưa tạo)* | Viewer | onemcp | Read-only | OneMCP portal |

**Status 2026-08-20**: role catalog OneMCP chưa tạo — Phase 3 sẽ tạo.

## App-level mapping table

### Grafana (via `[auth.generic_oauth].role_attribute_path`)

Zitadel emit claim `urn:zitadel:iam:org:project:roles` = object `{roleKey: {orgId: orgDomain}}`. Grafana JMESPath dùng `keys()` extract role names.

| Zitadel role | Grafana role | Ghi chú |
|---|---|---|
| `admin` | **GrafanaAdmin** (server-level, `is_admin=1`) | Full server + org admin |
| `ops` | **Editor** | Silence alert, edit dashboard |
| *(any other, incl `sale`, `user`)* | **Viewer** | Fallback JMESPath |

JMESPath expression (trong [infra/docker-compose.yml:767](../infra/docker-compose.yml#L767)):
```jmespath
contains(keys("urn:zitadel:iam:org:project:roles"), 'admin') && 'GrafanaAdmin'
|| contains(keys("urn:zitadel:iam:org:project:roles"), 'ops') && 'Editor'
|| 'Viewer'
```

**Priority multi-role**: nếu user có cả `admin` + `sale` → GrafanaAdmin (admin match trước). JMESPath `||` short-circuit.

### OpenWebUI (Phase 1 chưa ship)

*Pending — Phase 1 sẽ định nghĩa.*

Dự kiến:

| Zitadel role | OpenWebUI role | OpenWebUI group |
|---|---|---|
| `admin` | admin | (all) |
| `ops` | user | `ops` |
| `sale` | user | `sale` |
| `user` | user | *(none)* |

### OneMCP portal + backend (Phase 3 chưa ship)

*Pending — Phase 3 sẽ định nghĩa.*

## Cách admin thêm role mới

1. **Zitadel Console** → Projects → chọn project → Roles → **+ New**:
   - Role key: `<lowercase_name>` (tuân naming rule)
   - Display name: human-readable
   - Group: gán group semantic (sales, ops, dev, ...)
2. **Update doc này** — thêm row vào catalog table + mapping table cho từng app
3. **Update app config**:
   - Grafana: sửa `GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH` trong [infra/docker-compose.yml](../infra/docker-compose.yml), commit, deploy
   - OpenWebUI: (khi Phase 1 ship — sẽ document)
   - OneMCP: (khi Phase 3 ship — sẽ document)
4. **Grant role cho user**: Console → Users → user → Authorizations → Add / Edit grant

Deploy: theo host-sync-policy — commit local → push → VPS reset → docker compose up.

## Cách admin gán role cho user

1. Console → **Users** → chọn user → tab **Authorizations** (hoặc **Grants**)
2. Nếu chưa có grant project: **+ New** → chọn project + tick role
3. Nếu đã có grant: **Edit** → tick/untick role
4. Save
5. User cần **sign-out + sign-in lại app** để role mới có hiệu lực (Grafana đọc userinfo tại thời điểm login, không poll)

## Actions v2 mapping service (defer)

Cho scope hiện tại (4 apps, ~20 users, static catalog), mapping ở **app config layer** đủ. Deferred cân nhắc migrate sang Actions v2 target endpoint khi:
- Số role > 20 → JMESPath khó maintain
- Cần logic động (dept-based, time-based)
- Có > 6 app cần mapping (duplicate JMESPath ở mỗi app)

Effort estimate Actions v2 target: 4-6h build + deploy + register. Xem thảo luận 2026-08-20.

## Actions v1 status

**Deprecated 2026-08-20**. Action `complementRolesClaim` (v1) không chạy trên Zitadel v4.16.1 (nghi ngờ do `login_v2=true` bypass). Đã xoá khỏi console. Toàn bộ role reading giờ đọc trực tiếp raw claim `urn:zitadel:iam:org:project:roles`.

## Unresolved

- Có nên bật `has_project_check=true` trên project OneLog (block user không có grant nào login)? Cần audit user active không có grant trước.
- Naming convention có nên prefix role bằng app (`grafana.admin`, `openwebui.admin`) để tránh collision khi thêm app? Hiện đơn giản = 1 role catalog / 1 project, phù hợp scope.
