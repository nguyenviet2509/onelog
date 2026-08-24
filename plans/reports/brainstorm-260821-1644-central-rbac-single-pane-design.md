---
type: brainstorm
date: 2026-08-21
time: 16:44
slug: central-rbac-single-pane-design
status: agreed
next: /ck:plan
---

# Central RBAC Single-Pane Design (Zitadel + Central Portal)

## 1. Problem statement

INET KT stack (OneLog, OneMCP, Authway) đang mở rộng đa app (Cloud Panel, S3 Panel, Monitoring, portal khác) → cần **quản quyền tập trung** thay vì mỗi app tự làm RBAC + tự dựng user store.

Zitadel đã có làm IdP (Authway). Nhưng Zitadel:
- KHÔNG có Permission catalog first-class
- KHÔNG có Role → Permission mapping
- KHÔNG có Role hierarchy
- Console UI phức tạp, non-tech admin khó dùng

→ Cần layer trên Zitadel: **Central RBAC Portal** = single pane cho admin cấp quyền.

## 2. Requirements

**Function**
- Central Permission catalog (`<service>.<resource>.<action>`)
- Role definition + Role hierarchy (single-parent inheritance)
- Role → Permission mapping (many-to-many)
- User grant (user × role × project) — proxy xuống Zitadel Mgmt API
- Audit log
- Admin login SSO qua Zitadel (dogfood)

**Non-function**
- **Non-tech admin dùng được**: UI Vietnamese, tooltip, undo
- **Standardization từ đầu**: naming, versioning, schema stable → scale không phải đập
- **Token < 4KB**: permissions claim gọn (dùng permission hash nếu vượt)
- **Failure resilient**: Central down → Zitadel Action fail-open cached
- **Audit compliant**: mọi thay đổi log đầy đủ (actor, before, after, ip)
- **Latency**: Zitadel Action → Central `/resolve` < 100ms p99

## 3. Approaches evaluated

| Option | Mô tả | Ưu | Nhược | Verdict |
|---|---|---|---|---|
| **A** User Metadata only | Lưu permission list trực tiếp metadata mỗi user | Zero infra mới, KISS | Duplicate storage, update role = loop user, không có role first-class, UX admin tệ | ❌ Không scale |
| **B** YAML in Git + Zitadel Action | Config file trung tâm, Action fetch resolve | Zero service mới, Git audit tự nhiên, code review PR | Không có UI, dev-centric, non-tech chịu | ❌ Non-tech admin |
| **C** Full Central RBAC service (thin backend + no UI) | Postgres + REST API `/resolve` | Central storage, API-driven | Vẫn cần Zitadel Console cho admin ops → 2 UI | ❌ 2 UI |
| **C+** Full Central RBAC + Admin Portal UI (**single-pane**) | Backend + React UI proxy Zitadel Mgmt API | Admin 1 UI, non-tech friendly, chuẩn từ đầu | Effort ~3 tuần, thêm service ops | ✅ **CHỌN** |

**Alternative A** (Zitadel Console + backend-only) và **Alternative B** (CLI + Zitadel Console) đã evaluate ở rounds trước → loại vì non-tech admin.

## 4. Final recommendation

**Single-pane Central RBAC Portal** deploy trên `authway-vps` cùng Zitadel.

### Architecture

```
authway-vps (Docker Compose)
├── zitadel        (existing)  :8080   — IdP, OIDC, user, org, grant
├── central-rbac   (new)       :8083   — Backend Node/Go, REST API v1
├── central-rbac-ui (new)      :8082   — React admin UI
├── postgres       (existing)          — schemas: zitadel, rbac
├── redis          (new)               — resolve cache TTL 15min
└── caddy          (existing)  :443    — TLS termination (khi có subdomain)

Traffic:
  Admin (non-tech)
    → http://<vps-ip>:8082 (MVP)
    → https://rbac.000nethost.com (prod, Sectigo wildcard)
  Zitadel Action pre-token
    → http://central-rbac:8083/v1/resolve (docker internal, no TLS)
  Central RBAC → Zitadel Mgmt API v2
    → localhost:8080 (docker internal)
  Apps (Cloud Panel, S3 Panel, ...)
    → verify JWT qua Zitadel JWKS (existing pattern)
```

### Data ownership

| Data | Canonical | Notes |
|---|---|---|
| User, Org, Session, MFA, IdP | Zitadel | Central chỉ read qua Mgmt API |
| Project (= app boundary) | Zitadel | Central UI tạo/edit qua API |
| Role KEY per project | Zitadel (write via Central) | Central UI = front, ghi qua AddProjectRole |
| User grant (user × role) | Zitadel (write via Central) | Central UI = front, ghi qua AddUserGrant |
| Permission catalog | **Central Postgres** | Master |
| Role → Permission mapping | **Central Postgres** | Master |
| Role hierarchy | **Central Postgres** | Master |
| User metadata (dept, regions) | Zitadel | Attach cho ABAC |
| Audit log RBAC changes | Central Postgres + VictoriaLogs `_stream=rbac-audit` | |
| Audit log identity events | Zitadel event store + VL `_stream=zitadel` | |

## 5. Standards checklist (must-get-right từ đầu)

1. **Permission naming**: `<service>.<resource>.<action>` lowercase, dot-separated. **Immutable** sau commit. VD: `compute.instance.read`
2. **Role naming**: `<service>.<role>` VD `cloud.operator`. Không có generic `admin`
3. **Layer boundary**: Central = WHO+WHAT | App = WHERE+ALLOW/DENY. Cross-boundary = anti-pattern
4. **Hierarchy**: Single-parent inheritance only. Loops cấm (recursive CTE check)
5. **Tenancy**: 1 Zitadel Instance, N Organizations. Cross-org = Project Grant
6. **JWT claim contract v1**: `{ sub, org_id, roles[], permissions[], dept, regions[], ver:1, iat, exp }`. Đổi = bump ver
7. **Permission versioning**: Key immutable; rename = tạo mới + deprecate 6 tháng (alias map)
8. **Audit schema**: `{ ts, actor_id, actor_type, action, target_type, target_id, before, after, ip, session_id, correlation_id }`
9. **Failure mode**: Central down khi issue token → fail-open cached; admin ops → fail-close
10. **Break-glass**: 1 root user, permissions hardcoded trong Action v2, alert-on-use, 90d rotate
11. **API contract v1**: prefix `/v1/`. Endpoints: `resolve`, `roles`, `permissions`, `assignments`, `audit`, `users` (proxy)
12. **Bootstrap seed**: idempotent script, ~50 permissions + 10-15 roles từ mockup, 1 root admin

## 6. API contract v1 draft

```
Token issuance (Zitadel Action gọi):
  GET  /v1/resolve?roles=cloud.operator,billing.read
  →    { permissions: [...], resolved_roles: [...], cache_ttl: 900 }

Permission catalog:
  GET  /v1/permissions
  POST /v1/permissions        { key, description, application }
  PATCH /v1/permissions/:key  { description }  # key immutable
  DELETE /v1/permissions/:key  # cascade check

Role catalog:
  GET  /v1/roles
  POST /v1/roles              { key, application, parent_role?, permissions[] }
  PATCH /v1/roles/:key        { display_name, parent_role, permissions[] }
  DELETE /v1/roles/:key       # check no user grant

Assignment (proxy Zitadel):
  GET  /v1/assignments?user_id=X
  POST /v1/assignments        { user_id, project_id, role_keys[] }
  DELETE /v1/assignments/:id

User proxy:
  GET  /v1/users?q=&org_id=   # proxy Zitadel Mgmt API
  GET  /v1/users/:id          # detail + current grants

Audit:
  GET  /v1/audit?actor=&action=&from=&to=&limit=

Health:
  GET  /v1/health             { db, redis, zitadel_reachable }
```

## 7. JWT claim schema v1 draft

```json
{
  "sub": "user-uuid",
  "org_id": "org-uuid",
  "roles": ["cloud.operator", "billing.read"],
  "permissions": [
    "compute.instance.read",
    "compute.instance.create",
    "network.read",
    "billing.invoice.read"
  ],
  "dept": "cloud-infra",
  "regions": ["hn", "hcm"],
  "ver": 1,
  "iat": 1750000000,
  "exp": 1750003600,
  "iss": "https://zitadel.000nethost.com",
  "aud": ["cloud-panel", "s3-panel"]
}
```

Nếu `permissions` > 4KB → fallback: claim `permission_hash` + endpoint `/v1/resolve-by-hash/:hash` (app cache).

## 8. Postgres schema (Central RBAC)

```sql
CREATE SCHEMA rbac;

CREATE TABLE rbac.permissions (
  key         TEXT PRIMARY KEY CHECK (key ~ '^[a-z0-9._-]+$'),
  application TEXT NOT NULL,
  description TEXT,
  deprecated  BOOLEAN DEFAULT false,
  alias_of    TEXT REFERENCES rbac.permissions(key),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE rbac.roles (
  key         TEXT PRIMARY KEY,
  application TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  parent_role TEXT REFERENCES rbac.roles(key),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE rbac.role_permissions (
  role_key       TEXT REFERENCES rbac.roles(key) ON DELETE CASCADE,
  permission_key TEXT REFERENCES rbac.permissions(key),
  PRIMARY KEY (role_key, permission_key)
);

CREATE TABLE rbac.audit_log (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ DEFAULT now(),
  actor_id       TEXT NOT NULL,
  actor_type     TEXT NOT NULL,  -- 'user'|'system'|'break-glass'
  action         TEXT NOT NULL,  -- 'role.create', 'assignment.grant', ...
  target_type    TEXT,
  target_id      TEXT,
  before         JSONB,
  after          JSONB,
  ip             INET,
  session_id     TEXT,
  correlation_id TEXT
);

CREATE INDEX ON rbac.audit_log (ts DESC);
CREATE INDEX ON rbac.audit_log (actor_id);
CREATE INDEX ON rbac.audit_log (action);
```

## 9. Risk register

| Risk | Prob | Impact | Mitigation |
|---|---|---|---|
| Zitadel Action timeout (5s cap) | M | Token issue fail | Redis cache aggressive (15m), circuit breaker fail-open |
| JWT size > 4KB | M | Proxy 431 error | Permission hash fallback |
| Central-Zitadel drift (bypass Console) | L | Data lệch | Detect via audit stream diff, alert |
| Postgres down | L | Central RBAC down | Reuse existing backup, HA phase 2 |
| Break-glass abuse | L | Full compromise | MFA required, alert-on-use, 90d rotate, IP restrict |
| Migration khi rename permission | H | Break app | Alias mechanism, 6-month deprecation |
| Non-tech admin dùng IP + HTTP | M | Credential leak | MUST bật HTTPS trước go-live |
| Token contract change | L | Break app compat | Bump `ver`, giữ v1 song song |

## 10. Implementation roadmap (7 phases, ~15-19 ngày)

| Phase | Days | Deliverable |
|---|---|---|
| **1. Backend + DB** | 3-4 | Postgres schema, `/v1/resolve`, `/v1/roles/*`, `/v1/permissions/*` CRUD, audit log, unit tests |
| **2. Zitadel Action v2** | 2 | Pre-token hook, `/v1/resolve` call, Redis cache, break-glass logic, fail-open |
| **3. Zitadel Mgmt API integration** | 2 | Service client, `/v1/assignments` proxy `AddUserGrant`, sync role key `AddProjectRole` |
| **4. UI - Roles + Permissions** | 3-4 | React + Vite + shadcn/ui, tab Roles/Permissions CRUD, hierarchy tree view, i18n VN |
| **5. UI - Users + Assignments** | 3 | Tab Users (list Zitadel), Tab Assignments grant/revoke, bulk ops |
| **6. UI - Audit + polish** | 2 | Tab Audit log viewer, search/filter, VL panel embed link, tooltips |
| **7. Seed + deploy** | 1-2 | Bootstrap seed (permissions từ mockup), Docker compose, Caddy TLS, DNS subdomain, ops doc |

## 11. Success criteria

- Non-tech admin có thể cấp/gỡ role cho user trong ≤ 3 click
- Zitadel Action p99 latency < 100ms cho `/v1/resolve`
- Zero drift 30 ngày (audit diff Central ↔ Zitadel)
- JWT chứa `permissions` claim thay vì phải app resolve
- 100% audit event có `actor_id` + `before` + `after`
- Recovery time từ break-glass < 5 phút
- 1 root admin bootstrap được ≤ 15 phút từ blank state

## 12. Deployment topology (final)

- Host: **authway-vps**
- Stack extension: Docker Compose thêm `central-rbac`, `central-rbac-ui`, `redis`
- Postgres: reuse existing instance, schema mới `rbac`
- Backup: piggyback age-encrypted daily 02:00 (mở rộng dump)
- TLS: Caddy hiện tại + Sectigo wildcard `*.000nethost.com`
- Subdomain (đề xuất): `rbac.000nethost.com`
- Ports:
  - `:8082` UI (map ra ngoài qua Caddy 443)
  - `:8083` API (internal only qua docker network)
- Monitoring: Grafana panel mới đọc VL `_stream=rbac-audit`, alert on break-glass

## 13. Unresolved questions

1. **Subdomain `rbac.000nethost.com`** — đã đăng ký chưa? Nếu không có thì dùng IP MVP, chuyển subdomain trước go-live non-tech
2. **JWT signing key rotation** — Zitadel v4 auto rotate không? Nếu có, apps cần re-fetch JWKS
3. **Break-glass user password** — lưu ở đâu (1Password? vault?)? Ai giữ?
4. **Approval workflow** — chốt SKIP v1, nhưng cần confirm không compliance nào bắt buộc
5. **App migration** — Cloud Panel/S3 Panel hiện có RBAC riêng không? Cần plan migration hay build mới?
6. **Multi-language support** — UI Vietnamese only hay bilingual EN/VN từ đầu?
7. **RBAC data source of truth cho role key** — có nên central là canonical + sync xuống Zitadel? Round trước chốt Zitadel canonical, cần double-check khi lỗi drift
8. **Node vs Go cho backend** — nghiêng Node vì team quen TS, nhưng Go nhanh hơn cho endpoint hot `/resolve`. Cần benchmark hoặc chọn theo team preference
