# osh_admin integration handoff — OneMCP + Central RBAC

**Mục đích:** hướng dẫn dev osh_admin implement các phần cần thiết để osh_admin backend integrate được với hệ thống **OneMCP** (MCP server cho Claude Desktop) và **Central RBAC** (permissions catalog).

**Audience:** dev osh_admin (external, không familiar với OneMCP/Central RBAC codebase).

**Effort estimate:** ~1-2 tuần thực (SDK integrate là phần lớn, discovery endpoint ~30 phút).

**Trạng thái phía OneMCP:** ✅ shipped 2026-09-18 — hoàn toàn sẵn sàng. Chờ osh_admin done các item bên dưới để P5d prod swap.

---

## 1. TL;DR — cần deliver 3 thứ

| # | Item | Effort | Deliverable |
|---|---|---|---|
| A | Expose 2 files/endpoints manifest | ~1h | `.well-known/rbac-permissions.json` (static) + `GET /tools/list` (dynamic) |
| B | Integrate SDK Central RBAC + middleware | ~1 tuần | Backend osh_admin verify `X-Onemcp-User-Sub` → RBAC gate per-endpoint |
| C | Expose prod endpoint + bearer S2S | ~1h | Base URL prod + bearer token dài gửi cho OneMCP admin |

Sau khi 3 items done → OneMCP admin register upstream ~15 phút → tools live trong Claude Desktop.

---

## 2. Big picture — 30 giây

```
┌─────────────────┐     MCP tools/call      ┌──────────────┐    HTTP+Bearer     ┌──────────────┐
│ Claude Desktop  │ ──────────────────────► │   OneMCP     │ ─────────────────► │  osh_admin   │
│ (LLM agent)     │     with Bearer         │ (pure proxy) │  + X-User-Sub      │  (BẠN đây)   │
└─────────────────┘                         └──────────────┘                     └──────┬───────┘
                                                    │                                    │
                                                    │ live-fetch                         │ SDK.resolve
                                                    │ GET /tools/list                    │ (user perms)
                                                    ▼                                    ▼
                                            ┌──────────────┐                     ┌──────────────┐
                                            │  osh_admin   │                     │ Central RBAC │
                                            │  /tools/list │                     │  /v2/resolve │
                                            └──────────────┘                     └──────────────┘
```

**Nguyên tắc:**
- OneMCP = **pure proxy** — không đụng permissions, chỉ forward `X-Onemcp-User-Sub` (Zitadel sub) + `Authorization: Bearer` + `X-Onemcp-Correlation-Id`
- osh_admin = **RBAC gate owner** — verify user có quyền không, dùng SDK `central-rbac-client`
- Central RBAC = **permissions source of truth** — dev osh_admin publish manifest → Central admin apply → users được assign role

**Zero code coupling:** không có shared library/DB giữa 3 systems, chỉ HTTP contract.

---

## 3. 2 files/endpoints manifest — KHÔNG PHẢI 1

### File 1: `.well-known/rbac-permissions.json` (RBAC permissions catalog)

**Purpose:** declare permissions + default_roles cho app `osh_admin`. Central RBAC portal fetch để know "app này có permissions gì".

**Serving:** static file OK (Nginx/Express static route). Không cần backend logic.

**Auth:** public OK (theo design Central RBAC hiện tại). Nếu muốn bảo mật, có thể bearer-protect.

**Update pattern:** dev osh_admin publish version mới → Central admin click "Fetch + Diff + Apply" trong Central portal.

**Schema:**

```json
{
  "app_slug": "osh_admin",
  "version": "1.0.0",
  "permissions": [
    {
      "id": "osh_admin:tool.create_waf",
      "description": "Create WAF rule blocking IP/domain"
    },
    {
      "id": "osh_admin:tool.create_rate_limit",
      "description": "Set request rate limit for a domain"
    },
    {
      "id": "osh_admin:tool.query_access_log",
      "description": "Query HTTP access logs for a domain"
    }
  ],
  "default_roles": [
    {
      "id": "osh_admin.viewer",
      "permissions": ["osh_admin:tool.query_access_log"]
    },
    {
      "id": "osh_admin.operator",
      "permissions": [
        "osh_admin:tool.create_waf",
        "osh_admin:tool.create_rate_limit",
        "osh_admin:tool.query_access_log"
      ]
    }
  ]
}
```

**Field rules:**
- `app_slug` = `osh_admin` (fixed, match app đã register trên Central)
- `version` = semver `x.y.z` — bump khi có change
- `permission.id` = format `${app_slug}:${resource}.${action}` (VD `osh_admin:tool.create_waf`)
- `default_roles[].id` = format `${app_slug}.${role_name}` (VD `osh_admin.viewer`)

---

### File 2: `GET /tools/list` (bridges/tools catalog)

**Purpose:** declare tools/endpoints catalog cho OneMCP. OneMCP fetch để know "app này có bridges gì" → auto-populate vào MCP `tools/list` response cho Claude.

**Serving:** dynamic endpoint — recommend build từ router registry runtime (auto-include endpoint mới).

**Auth:** bearer-protected. OneMCP send `Authorization: Bearer <shared-token>`. Verify bearer trước khi trả JSON.

**Update pattern:** dev osh_admin thêm endpoint mới trong code → deploy → endpoint tự vào `/tools/list` response. OneMCP tự refetch trong ≤60s (cache TTL).

**Schema:**

```json
{
  "app_slug": "osh_admin",
  "version": "1.0.0",
  "tools": [
    {
      "name": "create_waf",
      "method": "POST",
      "path": "/waf/rules",
      "description": "Create WAF rule blocking IP/domain",
      "permission_id": "osh_admin:tool.create_waf",
      "param_schema": {
        "type": "object",
        "properties": {
          "domain": { "type": "string", "description": "Target domain" },
          "ip": { "type": "string", "description": "Source IP to block (optional)" }
        },
        "required": ["domain"],
        "additionalProperties": false
      }
    },
    {
      "name": "create_rate_limit",
      "method": "POST",
      "path": "/rate-limits",
      "description": "Set request rate limit for a domain",
      "permission_id": "osh_admin:tool.create_rate_limit",
      "param_schema": {
        "type": "object",
        "properties": {
          "domain": { "type": "string" },
          "limit_rps": { "type": "number", "description": "Max requests per second" }
        },
        "required": ["domain", "limit_rps"],
        "additionalProperties": false
      }
    },
    {
      "name": "query_access_log",
      "method": "GET",
      "path": "/access-logs",
      "description": "Query recent access log entries for a domain",
      "permission_id": "osh_admin:tool.query_access_log",
      "param_schema": {
        "type": "object",
        "properties": {
          "domain": { "type": "string" },
          "since": { "type": "string", "description": "ISO timestamp" },
          "limit": { "type": "number", "description": "Max entries (5-100, default 20)" }
        },
        "required": ["domain"],
        "additionalProperties": false
      }
    }
  ]
}
```

**Field rules:**
- `tools[].name` = snake_case `[a-z_][a-z0-9_]*`, max 64 chars — dùng làm MCP tool name (LLM sẽ gọi bằng name này)
- `tools[].method` = `GET|POST|PUT|DELETE`
- `tools[].path` = path relative bắt đầu bằng `/`, max 512 chars
- `tools[].description` = mô tả cho LLM biết khi nào dùng tool
- `tools[].permission_id` = phải match 1 entry trong `permissions[]` của File 1 (FK reference)
- `tools[].param_schema` = JSON Schema (type=object, properties, required, additionalProperties=false)

**Constraints:**
- Tools array: **max 100 items**
- Response body: **max 100KB**
- Timeout OneMCP: **10 giây** — endpoint phải trả nhanh (static list, không heavy compute)

**Best practice:** build tools list dynamic từ router registry (không hardcode). Khi dev thêm endpoint mới có metadata `@Tool({...})` decorator → tự động append vào `/tools/list` response.

---

### Vì sao 2 files, không gộp 1?

| Aspect | Nếu gộp 1 file | 2 files riêng (chọn) |
|---|---|---|
| Consumer | Central + OneMCP cùng fetch → duplicate logic | Mỗi consumer chỉ care phần của mình |
| Update cadence | Bridges đổi hàng ngày → force permissions "re-publish" → noise cho Central admin | Bridges auto (60s), permissions manual — tách cadence phù hợp |
| Auth model | 1 file phải chọn public HOẶC bearer → xung đột | Mỗi endpoint auth model tối ưu riêng |
| Fault isolation | 1 file broken → cả RBAC + tools fail | Tách — 1 broken không kéo cái kia |
| Schema evolution | Central manifest v1 spec fixed → thêm `tools[]` = breaking Central | Discovery endpoint schema mới hoàn toàn, không đụng Central spec |
| Version semantic | 1 version phục vụ 2 loại change → khó bump | Bump độc lập |

---

### Relationship 2 files: FK reference

```
.well-known/rbac-permissions.json           GET /tools/list
├─ permissions[]                            ├─ tools[]
│   ├─ id: "osh_admin:tool.create_waf" ◄────┼─── permission_id (FK)
│   ├─ id: "osh_admin:tool.create_rate..." ◄┼─── permission_id (FK)
│   └─ id: "osh_admin:tool.query_log"   ◄───┼─── permission_id (FK)
└─ default_roles[]                          └─ ...
```

**Ordering khi thêm tool mới cần permission mới:**
1. Publish `rbac-permissions.json` version mới (thêm permission)
2. Central admin apply manifest → permission active trong Central DB
3. Deploy osh_admin code (endpoint mới + auto vào `/tools/list`)
4. OneMCP discover endpoint ≤60s (cache TTL) hoặc admin click "Refresh cache" trong OneMCP portal
5. User đã có role chứa perm mới → gọi được tool

**Nếu skip bước 1-2:** user gọi tool sẽ nhận 403 vì Central không biết permission đó tồn tại → SDK resolve trả `[]` → middleware deny.

---

## 4. Việc cần dev osh_admin làm — 7 items

### Item 0 (RECOMMENDED — ~30 phút): Expose `GET /tools/list`

**Purpose:** enable live discovery. OneMCP auto-fetch, dev osh_admin không cần nhờ ai register bridge thủ công.

**Alternative:** nếu chưa muốn implement discovery endpoint, OneMCP admin có thể register bridges thủ công qua portal (legacy path). Nhưng mất autonomy — thêm endpoint mới phải ping OneMCP admin.

**Example — Express (Node.js):**

```javascript
// tools-list-route.js
const TOOLS = [
  {
    name: 'create_waf',
    method: 'POST',
    path: '/waf/rules',
    description: 'Create WAF rule blocking IP/domain',
    permission_id: 'osh_admin:tool.create_waf',
    param_schema: {
      type: 'object',
      properties: { domain: { type: 'string' }, ip: { type: 'string' } },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  // ... build dynamic từ router registry (recommend)
];

function requireOneMcpBearer(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${process.env.ONEMCP_BEARER}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/tools/list', requireOneMcpBearer, (req, res) => {
  res.json({ app_slug: 'osh_admin', version: '1.0.0', tools: TOOLS });
});
```

**Verify:**
```bash
curl -H "Authorization: Bearer $ONEMCP_BEARER" \
     https://osh-admin.your-domain/tools/list | jq .
```

**Best practice:** dùng decorator/annotation trên endpoint để auto-collect metadata:
```javascript
// route registration
router.post('/waf/rules', {
  tool: { name: 'create_waf', permission_id: 'osh_admin:tool.create_waf', ... }
}, createWafHandler);

// tools/list builder scans router → auto-populate TOOLS array
```

---

### Item 1: Register app osh_admin trên Central RBAC portal

**Purpose:** get app_slug + app token để osh_admin backend gọi được SDK Central RBAC.

**Steps:**
1. Login `https://central-rbac.inet.vn` (admin role)
2. Menu **Apps** → **New app**
3. Tên: `osh_admin`, slug: `osh_admin`
4. Wizard tạo Zitadel project auto (hoặc adopt existing nếu đã có)
5. Copy app token format `rbac_<8chars>_<24chars>` → save vào env osh_admin backend (VD `CENTRAL_RBAC_TOKEN`)

---

### Item 2: Publish `.well-known/rbac-permissions.json`

Xem chi tiết schema ở [Section 3, File 1](#file-1-well-knownrbac-permissionsjson-rbac-permissions-catalog).

**Serving example (Express):**
```javascript
app.get('/.well-known/rbac-permissions.json', (req, res) => {
  res.json({
    app_slug: 'osh_admin',
    version: '1.0.0',
    permissions: [...],
    default_roles: [...],
  });
});
```

Hoặc serve static file nếu deploy qua Nginx:
```nginx
location /.well-known/rbac-permissions.json {
    alias /var/www/osh_admin/rbac-permissions.json;
    default_type application/json;
}
```

**Sau khi publish:** báo Central admin fetch + apply manifest.

---

### Item 3: Integrate `central-rbac-client` SDK

**SDK repo:** `d:/Vietnt/Project/onelog/central-rbac-client/nodejs` (hoặc `python`, `go` — tùy stack)

**SDK features (built-in):**
- LRU cache 60s per user_sub (giảm QPS gọi Central)
- Circuit breaker (5 fail → open 30s → auto-recover)
- Epoch poller 10s (revocation visible ≤10s)
- Fail-closed on error (deny by default)

**Node/TypeScript example:**
```typescript
import { CentralRbacClient } from 'central-rbac-client';

export const rbac = new CentralRbacClient({
  baseUrl: process.env.CENTRAL_RBAC_URL,        // https://central-rbac.inet.vn
  appSlug: 'osh_admin',
  token: process.env.CENTRAL_RBAC_TOKEN,        // rbac_xxx từ Item 1
  cacheMaxAgeMs: 60_000,                        // default OK
  circuitBreaker: { threshold: 5, resetMs: 30_000 },
});
```

Init 1 lần global instance, dùng cho tất cả requests.

---

### Item 4: Middleware verify `X-Onemcp-User-Sub` + gate per-endpoint

**Purpose:** thay thế fake RBAC gate. Fail-closed: SDK error → 503.

**Express example:**
```javascript
const routePerm = {
  'POST /waf/rules':     'osh_admin:tool.create_waf',
  'POST /rate-limits':   'osh_admin:tool.create_rate_limit',
  'GET /access-logs':    'osh_admin:tool.query_access_log',
};

app.use(async (req, res, next) => {
  const sub = req.headers['x-onemcp-user-sub'];
  if (!sub) return res.status(401).json({ error: 'missing X-Onemcp-User-Sub' });

  const key = `${req.method} ${req.path}`;
  const requiredPerm = routePerm[key];
  if (!requiredPerm) return next();  // route không cần permission

  try {
    const perms = await rbac.resolve({ sub, tenant: 'default' });
    if (!perms.includes(requiredPerm)) {
      return res.status(403).json({
        error: 'forbidden',
        missing_permission: requiredPerm,
      });
    }
    next();
  } catch (e) {
    // Fail-closed: circuit open hoặc Central down → deny
    res.status(503).json({ error: 'authorization service unavailable' });
  }
});
```

**Log correlation:** log `X-Onemcp-Correlation-Id` header vào application log → debug cross-system trace.

---

### Item 5: Expose prod endpoint URL + cấp bearer S2S cho OneMCP

**Deliver sang OneMCP admin:**
1. Base URL prod (VD `https://gateway.inet.vn:8443/osh_admin`)
2. Bearer token dài (**min 32 chars random**) — dùng service-to-service, không phải user OAuth
3. Confirm 3 endpoint paths khớp `/tools/list` response
4. Confirm bearer cho `/tools/list` cùng bearer với tool call endpoints (single bearer per upstream)

**⚠️ Bảo mật:** deliver bearer qua **Bitwarden/1Password vault**, KHÔNG email/Slack/chat.

---

### Item 6: Confirm exposure model → decides security mechanism

**Trả lời 1 trong 3:**

**A. LAN-only** (osh_admin chỉ accept traffic từ OneMCP VPC/subnet)
- IP whitelist middleware + firewall block internet
- Plaintext `X-Onemcp-User-Sub` header OK
- Chọn nếu deploy trong same VPC

**B. Public** (osh_admin expose qua public gateway)
- **CẤM plaintext trust** — attacker cùng subnet gateway có thể spoof sub
- REQUIRE HMAC signed `X-Onemcp-User-Sub` (shared secret Vault)
- +1-2d scope cho OneMCP thêm HMAC compute

**C. Hybrid** (internal path + public gateway)
- Path-based routing: public → HMAC, internal → IP whitelist
- Document per-bridge trong metadata

---

## 5. Runtime workflow — khi nào cần Central sync manifest?

**Rule of thumb:** "Thay đổi có touching `permission_id` hoặc `default_roles` trong `rbac-permissions.json` không?"
- **CÓ** → publish manifest mới + Central admin apply
- **KHÔNG** → chỉ deploy osh_admin code, bridges auto-refresh qua `/tools/list` (≤60s)

### Decision matrix

| Loại thay đổi | Dev osh_admin làm | Central admin làm |
|---|---|---|
| Endpoint mới (permission cũ) | Deploy + endpoint auto vào `/tools/list` | ❌ Không cần |
| Sửa endpoint (path/method/schema), permission cũ | Deploy + `/tools/list` auto-update | ❌ Không cần |
| Endpoint mới cần permission MỚI | Deploy + publish manifest v mới | ✅ Apply manifest |
| Xoá endpoint, permission còn active elsewhere | Deploy, endpoint drop khỏi `/tools/list` | ❌ Không cần |
| Xoá permission cũ (không endpoint dùng) | Publish manifest mới (không include perm) | ✅ Apply → soft-delete |
| Rename `permission_id` (breaking) | Publish manifest (cũ removed + mới added) | ✅ Apply + re-assign roles cho users |
| Đổi permission description | Publish manifest | ✅ Apply (defer OK, không critical) |
| Thêm/sửa/xoá `default_roles` | Publish manifest mới | ✅ Apply → auto-provision role cho users mới |
| Đổi business logic internal endpoint (contract giữ nguyên) | Deploy | ❌ Không cần |
| Bump `/tools/list` version (breaking param_schema) | Deploy + bump `version` field | ❌ Không cần (OneMCP admin có thể click Refresh cache nếu cần immediate) |

### 2 layers mental model

**Bridges layer (endpoint shape):**
- Quản lý qua `GET /tools/list`
- OneMCP tự discover ≤60s
- Central KHÔNG quan tâm
- Dev osh_admin autonomy 100%

**Permissions layer (RBAC catalog):**
- Quản lý qua `.well-known/rbac-permissions.json`
- Publish + Central admin apply
- Source of truth cho "ai được gọi tool nào"

2 layers này **orthogonal**. Endpoint shape đổi không cần Central. Permission catalog đổi mới cần.

---

## 6. E2E workflow — happy path

### Setup once (7 items checklist trong Section 4)

```
Dev osh_admin                Central admin              OneMCP admin
──────────────               ─────────────              ────────────
1. Register app                                         
2. Publish rbac-perms.json ─►fetch + apply
3. Expose GET /tools/list
4. Integrate SDK
5. Add middleware
6. Expose prod endpoint URL + bearer ────────────────►  Register upstream
7. Confirm exposure model                                (base_url + bearer + discovery_url)
                                                        ↓
                                                        OneMCP auto-load bridges (≤60s)
                                                        ↓
                                                        Tools visible trong Claude Desktop
```

### Iterate freely (post-setup)

```
Case A — Thêm endpoint dùng permission ĐÃ CÓ (majority):
─────────────────────────────────────────────────────
Dev viết endpoint code
    ↓
Endpoint auto-append vào GET /tools/list (dynamic router)
    ↓
Deploy osh_admin
    ↓
OneMCP cache TTL expire (≤60s) HOẶC admin click "Refresh cache"
    ↓
Tool visible trong Claude Desktop → LLM gọi ngay


Case B — Thêm endpoint cần permission MỚI:
───────────────────────────────────────────
1. Publish rbac-perms.json v mới (add permission)
2. Central admin apply manifest
3. Deploy osh_admin (endpoint + tools/list update)
4. OneMCP discover ≤60s
5. Ensure users có role chứa perm mới (assign qua Central portal)
6. User gọi tool → OK
```

### Runtime: mỗi tool call (distributed check)

```
User (Actor)                         
   │ "Chặn IP 1.2.3.4 cho foo.com"    
   ▼                                   
Claude Desktop                         
   │ tools/call create_waf {domain: foo.com, ip: 1.2.3.4}
   ▼                                   
OneMCP (pure proxy)                    
   │ verify OAuth → extract Zitadel sub 
   │ validate args vs param_schema      
   │ forward: POST /waf/rules            
   │   + Authorization: Bearer <S2S>     
   │   + X-Onemcp-User-Sub: <sub>        
   │   + X-Onemcp-Correlation-Id: <uuid> 
   ▼                                   
osh_admin backend                      
   │ middleware: rbac.resolve(sub, tenant)
   │   ├─ cache hit ~1ms                
   │   └─ cache miss → Central /v2/resolve ~500ms
   │ if user có osh_admin:tool.create_waf → next
   │ else → 403 forbidden               
   │ execute business logic             
   │ 200 { waf_id: 'waf-abc' }         
   ▼                                   
OneMCP                                 
   │ audit publish async                
   │ forward response                   
   ▼                                   
Claude Desktop                         
   │ "Đã chặn IP 1.2.3.4 cho foo.com — waf-abc"
   ▼                                   
User                                   
```

**Latency:** ~50ms (cache hit) — ~600ms (cache miss).

---

## 7. Testing checklist

### 7.1. Verify `.well-known/rbac-permissions.json`

```bash
curl https://osh-admin.your-domain/.well-known/rbac-permissions.json | jq .
```

Expect: valid JSON với `app_slug=osh_admin` + `permissions[]` + `default_roles[]`.

### 7.2. Verify `GET /tools/list`

```bash
# Không bearer → 401
curl -i https://osh-admin.your-domain/tools/list
# Expect: 401 unauthorized

# Với bearer → 200
curl -H "Authorization: Bearer $ONEMCP_BEARER" \
     https://osh-admin.your-domain/tools/list | jq .
# Expect: valid JSON với tools[]
```

Validate schema với `jq` hoặc [JSON Schema validator](https://www.jsonschemavalidator.net/):
- `app_slug` = `osh_admin`
- `version` = semver `x.y.z`
- Mỗi tool: `name` snake_case, `method` in [GET,POST,PUT,DELETE], `path` starts `/`, `param_schema` valid JSON Schema

### 7.3. Verify RBAC middleware

```bash
# Missing X-Onemcp-User-Sub → 401
curl -X POST -H "Authorization: Bearer $ONEMCP_BEARER" \
     https://osh-admin.your-domain/waf/rules
# Expect: 401 "missing X-Onemcp-User-Sub"

# User không có permission → 403
curl -X POST \
     -H "Authorization: Bearer $ONEMCP_BEARER" \
     -H "X-Onemcp-User-Sub: user-without-perm" \
     -d '{"domain":"foo.com"}' \
     https://osh-admin.your-domain/waf/rules
# Expect: 403 "forbidden, missing_permission: osh_admin:tool.create_waf"

# User có permission → 200
curl -X POST \
     -H "Authorization: Bearer $ONEMCP_BEARER" \
     -H "X-Onemcp-User-Sub: user-with-operator-role" \
     -d '{"domain":"foo.com"}' \
     https://osh-admin.your-domain/waf/rules
# Expect: 200 { waf_id: '...' }
```

### 7.4. Verify E2E qua Claude Desktop

Yêu cầu OneMCP admin sync với anh Trí để E2E test:
1. OneMCP admin register upstream `osh_admin` prod
2. Add role `osh_admin.operator` cho user test qua Central portal
3. User test đăng nhập Claude Desktop, chọn MCP server `onemcp`
4. Chat: "Chặn IP 5.6.7.8 cho foo.com"
5. Expect: Claude gọi `create_waf` → osh_admin trả `waf_id` → Claude echo kết quả
6. Verify correlation ID chain trong logs 3 systems: OneMCP audit + osh_admin log + Central RBAC log

---

## 8. FAQ / troubleshooting

**Q: Deploy endpoint mới nhưng tool không visible trong Claude?**
A: Chờ tối đa 60s (cache TTL) hoặc yêu cầu OneMCP admin click "Refresh cache" trong `/admin/tool-bridges` portal. Check `/tools/list` response include endpoint mới chưa (`curl` verify).

**Q: User gọi tool nhận 403 permission_denied?**
A: 3 nguyên nhân:
1. Permission chưa publish trong `rbac-permissions.json` → publish + Central apply
2. Permission đã publish nhưng user chưa được assign role chứa permission → Central admin assign role
3. SDK cache stale — chờ ≤60s hoặc restart osh_admin

**Q: Bearer bị leak, cần rotate?**
A: Generate bearer mới → deliver cho OneMCP admin qua Bitwarden → OneMCP admin update upstream config qua portal (bearer sẽ được encrypt AES-256-GCM). Không cần rebuild.

**Q: Central RBAC down, osh_admin còn work không?**
A: SDK circuit breaker sẽ open sau 5 fail liên tiếp → mọi request bị deny với 503 (fail-closed). Đây là design intent — không muốn accept request khi không verify được permission.

**Q: Version bump `/tools/list` (breaking param_schema field rename)?**
A: Bump `version` field trong response + báo OneMCP admin. Admin có thể click "Refresh cache" để force update ngay (không đợi 60s TTL).

**Q: Nếu chưa implement `/tools/list` được thì sao?**
A: OneMCP admin có thể register bridges thủ công qua portal (legacy path, backward compat). Không autonomy nhưng vẫn work. Recommend implement `/tools/list` sau cho tiện.

**Q: OneMCP admin có thể xoá bridge của tôi không?**
A: Bridges auto-discovered từ `/tools/list` là **read-only** trong OneMCP portal (Admin không thể edit/delete). Muốn xoá tool → remove khỏi `/tools/list` response → deploy → sau 60s tool disappear.

---

## 9. References

- **OneMCP bridge discovery spec (full):** [`onemcp-bridge-discovery-spec.md`](./onemcp-bridge-discovery-spec.md) — 509 lines, chi tiết endpoint contract + 4 code examples (Express/NestJS/Go/Python) + FAQ
- **OneMCP tool bridge guideline:** [`onemcp-tool-bridge-guideline.md`](./onemcp-tool-bridge-guideline.md) — architecture overview
- **OneMCP tool bridge runbook:** [`onemcp-tool-bridge-runbook.md`](./onemcp-tool-bridge-runbook.md) — troubleshooting cho OneMCP admin
- **Workflow mockup HTML:** [`mockups/onemcp-osh-admin-bridge-workflow.html`](../mockups/onemcp-osh-admin-bridge-workflow.html) — visual overview 2 systems
- **Central RBAC client SDK:** `d:/Vietnt/Project/onelog/central-rbac-client/nodejs` (hoặc `python`, `go`)

## Contact

- **OneMCP owner:** trihd@inet.vn
- **Central RBAC owner:** trihd@inet.vn
- **Repos:**
  - OneMCP: `D:/Vietnt/Project/onemcp` (private)
  - OneLog (docs + Central): `d:/Vietnt/Project/onelog` (private)

## Unresolved / open questions

- Exposure model (LAN vs Public) — chờ dev osh_admin confirm để OneMCP quyết định có cần HMAC signed header không
- Timeline dev osh_admin done 7 items — estimate ~1-2 tuần, cần confirm để OneMCP schedule P5d
