# osh_admin integration handoff — OneMCP + Central RBAC

**Mục đích:** hướng dẫn dev osh_admin implement các phần cần thiết để osh_admin backend integrate với **OneMCP** (MCP server cho Claude Desktop) và **Central RBAC** (per-user permission check).

**Audience:** dev osh_admin.

**Effort estimate:** ~1-2 tuần (SDK integrate + middleware là phần lớn).

**Trạng thái phía OneMCP:** ✅ shipped 2026-09-18 — hoàn toàn sẵn sàng. Chờ osh_admin done các item bên dưới.

**⚠️ RBAC bắt buộc — không defer:** tools osh_admin (WAF, rate limit, ...) impact production hạ tầng thật → phải phân quyền per-user để ngăn user vô ý/malicious gọi destructive tools.

---

## 1. TL;DR — 3 groups deliverables

| Group | Items | Effort |
|---|---|---|
| **A. Discovery** | Expose `GET /tools/list` (bearer-protected) | ~30 phút |
| **B. RBAC** | Publish `.well-known/rbac-permissions.json` + SDK integrate + middleware verify user permissions | ~1 tuần |
| **C. Ops** | Deploy prod endpoint + cấp bearer S2S cho OneMCP admin + confirm exposure model | ~2 giờ |

Sau khi 3 groups done → OneMCP admin register upstream ~15 phút → tools live trong Claude Desktop.

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
- OneMCP = **pure proxy** — forward `X-Onemcp-User-Sub` (Zitadel sub) + `Authorization: Bearer` + `X-Onemcp-Correlation-Id`
- osh_admin = **RBAC gate owner** — verify user có quyền không (SDK `central-rbac-client`) + thực hiện business logic
- Central RBAC = **permissions source of truth** — dev osh_admin publish manifest → Central admin apply → users assigned role → SDK resolve khi có request

**Zero code coupling:** không share DB/library giữa 3 systems, chỉ HTTP contract (bearer S2S + header identity).

---

## 3. 2 files/endpoints cần expose — KHÔNG PHẢI 1

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
    { "id": "osh_admin:tool.create_waf", "description": "Create WAF rule blocking IP/domain" },
    { "id": "osh_admin:tool.create_rate_limit", "description": "Set request rate limit" },
    { "id": "osh_admin:tool.query_access_log", "description": "Query HTTP access logs" }
  ],
  "default_roles": [
    { "id": "osh_admin.viewer", "permissions": ["osh_admin:tool.query_access_log"] },
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

**Purpose:** OneMCP fetch endpoint này mỗi 60s (cache TTL) để auto-discover tools mới. Dev osh_admin thêm/sửa endpoint → auto visible trong Claude Desktop ≤60s.

**Contract:**
- URL: `GET ${base_url}/tools/list` (path có thể tùy chọn khác, config OneMCP-side)
- Auth: `Authorization: Bearer <shared-token>` — verify trước khi trả JSON
- Response body: max 100KB
- Response time: OneMCP timeout 10s
- HTTPS required trong prod (dev có thể HTTP nếu OneMCP có `DEV_ALLOW_HTTP_DISCOVERY=true`)

**Response schema:**

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
    }
  ]
}
```

**Field rules:**
- `tools[].name` = snake_case `[a-z_][a-z0-9_]*`, max 64 chars — LLM sẽ gọi bằng name này
- `tools[].method` = `GET|POST|PUT|DELETE`
- `tools[].path` = path relative bắt đầu bằng `/`, max 512 chars
- `tools[].description` = mô tả **cho LLM đọc** để biết khi nào dùng tool (xem best practice section 6)
- `tools[].permission_id` = **PHẢI match 1 entry trong `permissions[]` của File 1** (FK reference — middleware dùng để gate)
- `tools[].param_schema` = JSON Schema (type=object, properties, required, additionalProperties=false)
- Tools array: **max 100 items**

**Best practice:** build tools list dynamic từ router registry (không hardcode). Khi dev thêm endpoint mới có metadata `@Tool({...})` decorator → tự động append vào `/tools/list` response → không cần update thủ công.

---

### Relationship 2 files: FK reference

```
.well-known/rbac-permissions.json           GET /tools/list
├─ permissions[]                            ├─ tools[]
│   ├─ id: "osh_admin:tool.create_waf" ◄────┼─── permission_id (FK)
│   ├─ id: "osh_admin:tool.create_rate..."◄─┼─── permission_id (FK)
│   └─ id: "osh_admin:tool.query_log"   ◄───┼─── permission_id (FK)
└─ default_roles[]                          └─ ...
```

**Ordering khi thêm tool mới cần permission mới:**
1. Publish `rbac-permissions.json` version mới (thêm permission)
2. Central admin apply manifest → permission active trong Central DB
3. Deploy osh_admin code (endpoint mới + auto vào `/tools/list`)
4. OneMCP discover endpoint ≤60s (cache TTL) hoặc admin click "Refresh cache" trong OneMCP portal
5. User có role chứa perm mới → gọi được tool

**Nếu skip bước 1-2:** user gọi tool sẽ nhận 403 vì Central không biết permission đó tồn tại → SDK resolve trả `[]` → middleware deny.

---

## 4. Việc cần dev osh_admin làm — chi tiết

### Item 1: Expose `GET /tools/list`

**Example — Express (Node.js):**

```javascript
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

---

### Item 2: Register app osh_admin trên Central RBAC portal

**Steps:**
1. Login `https://central-rbac.inet.vn` (admin role)
2. Menu **Apps** → **New app**
3. Tên: `osh_admin`, slug: `osh_admin`
4. Wizard tạo Zitadel project auto (hoặc adopt existing nếu đã có)
5. Copy app token format `rbac_<8chars>_<24chars>` → save vào env osh_admin backend (VD `CENTRAL_RBAC_TOKEN`)

---

### Item 3: Publish `.well-known/rbac-permissions.json`

Schema xem [Section 3, File 1](#file-1-well-knownrbac-permissionsjson-rbac-permissions-catalog).

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

**Sau khi publish:** báo Central admin (anh Trí) fetch + apply manifest.

---

### Item 4: Integrate `central-rbac-client` SDK

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
  token: process.env.CENTRAL_RBAC_TOKEN,        // rbac_xxx từ Item 2
  cacheMaxAgeMs: 60_000,                        // default OK
  circuitBreaker: { threshold: 5, resetMs: 30_000 },
});
```

Init 1 lần global instance, dùng cho tất cả requests.

---

### Item 5: Middleware verify `X-Onemcp-User-Sub` + gate per-endpoint

**Purpose:** RBAC gate thật — verify user có quyền gọi tool không. Fail-closed: SDK error → 503.

**Express example:**
```javascript
const routePerm = {
  'POST /waf/rules':     'osh_admin:tool.create_waf',
  'POST /rate-limits':   'osh_admin:tool.create_rate_limit',
  'GET /access-logs':    'osh_admin:tool.query_access_log',
};

// Middleware 1: verify bearer S2S (áp dụng chung cho tất cả endpoints)
app.use(requireOneMcpBearer);

// Middleware 2: RBAC gate per-endpoint
app.use(async (req, res, next) => {
  const sub = req.headers['x-onemcp-user-sub'];
  if (!sub) return res.status(401).json({ error: 'missing X-Onemcp-User-Sub' });

  const key = `${req.method} ${req.path}`;
  const requiredPerm = routePerm[key];
  if (!requiredPerm) return next();  // route không cần permission (VD /health, /tools/list)

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

```javascript
app.use((req, res, next) => {
  const correlationId = req.headers['x-onemcp-correlation-id'] || 'no-corr-id';
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    method: req.method,
    path: req.path,
    correlation_id: correlationId,
    user_sub: req.headers['x-onemcp-user-sub'],
  }));
  next();
});
```

---

### Item 6: Deploy prod + deliver credentials cho OneMCP admin

**Deliverables sang OneMCP admin (anh Trí):**
1. Base URL prod (VD `https://gateway.inet.vn:8443/osh_admin`)
2. Bearer token dài (**min 32 chars random**) — cùng bearer cho `/tools/list` và tool call endpoints
3. Confirm exposure model (A/B/C bên dưới)
4. Confirm endpoint paths khớp `/tools/list` response

**⚠️ Bảo mật:** deliver bearer qua **Bitwarden/1Password vault**, KHÔNG email/Slack/chat.

**Exposure model — chọn 1 trong 3:**

**A. LAN-only** (recommended nếu deploy same VPC với OneMCP)
- IP whitelist middleware osh_admin: chỉ accept từ OneMCP subnet
- Firewall block internet
- Plaintext `X-Onemcp-User-Sub` header OK

**B. Public** (nếu deploy khác VPC/DC)
- **CẤM plaintext trust** — attacker cùng subnet gateway có thể spoof sub
- REQUIRE HMAC signed `X-Onemcp-User-Sub` (shared secret Vault)
- +1-2d scope cho OneMCP thêm HMAC compute → cần discuss với anh Trí trước

**C. Hybrid** (internal path + public gateway)
- Path-based routing: public → HMAC, internal → IP whitelist
- Document per-bridge trong metadata

---

## 5. E2E workflow

### Setup once (6 items checklist trong Section 4)

```
Dev osh_admin                          Central admin                OneMCP admin
──────────────                         ─────────────                ────────────
1. Expose /tools/list
2. Register app osh_admin
3. Publish rbac-perms.json ────►fetch + apply
4. Integrate SDK
5. Add middleware
6. Deploy prod + deliver credentials ─────────────────────────►  Register upstream (~15 phút)
                                                                  (base_url + bearer + discovery_url)
                                                                  ↓
                                                                  OneMCP auto-load bridges (≤60s)
                                                                  ↓
                                                                  Central admin assign role cho users
                                                                  ↓
                                                                  Tools visible + callable trong Claude Desktop
```

### Iterate freely (post-setup)

**Case A — Thêm endpoint dùng permission ĐÃ CÓ (majority case):**
```
Dev viết endpoint code
    ↓
Endpoint auto-append vào /tools/list (dynamic router)
    ↓
Deploy osh_admin
    ↓
OneMCP cache TTL expire (≤60s) HOẶC admin click "Refresh cache"
    ↓
Tool visible trong Claude Desktop → LLM gọi ngay
```

**Case B — Thêm endpoint cần permission MỚI:**
```
1. Publish rbac-perms.json v mới (add permission)
2. Central admin apply manifest
3. Deploy osh_admin (endpoint + tools/list update)
4. OneMCP discover ≤60s
5. Ensure users có role chứa perm mới (Central admin assign)
6. User gọi tool → OK
```

**Rule of thumb:** "Thay đổi có touching `permission_id` hoặc `default_roles` trong manifest không?"
- **CÓ** → publish manifest + Central admin apply
- **KHÔNG** → chỉ deploy osh_admin, bridges auto-refresh qua `/tools/list` (≤60s)

### Runtime: mỗi tool call (distributed check)

```
User: "Chặn IP 5.6.7.8 cho foo.com"
    ↓
Claude Desktop (LLM chọn tool create_waf từ description)
    ↓
OneMCP nhận tools/call
    ├─ verify OAuth user → extract Zitadel sub
    ├─ validate args vs param_schema
    └─ forward: POST /waf/rules
         + Authorization: Bearer <S2S>
         + X-Onemcp-User-Sub: <zitadel_sub>
         + X-Onemcp-Correlation-Id: <uuid>
         + body: { domain, ip }
    ↓
osh_admin
    ├─ verify bearer ✓
    ├─ SDK.resolve(sub, tenant) — cache hit ~1ms / cache miss → Central /v2/resolve ~500ms
    ├─ if user có osh_admin:tool.create_waf → next, else 403
    ├─ execute business logic
    └─ return 201 { waf_id, domain, ip }
    ↓
OneMCP forward response
    ↓
Claude Desktop trả cho user: "Đã chặn IP..."
```

**Latency:** ~50ms (cache hit) — ~600ms (cache miss).

---

## 6. Best practices — viết tool `description` cho LLM

**Đây là phần CRITICAL** — LLM (Claude) đọc `description` để quyết định khi nào gọi tool. Description viết dở → LLM **fall back generic answer thay vì gọi tool**, users không thấy giá trị của MCP integration.

**Ownership boundary:** dev osh_admin **100% sở hữu** `description` field. OneMCP chỉ forward raw, không mutate. Nghĩa là chất lượng UX end-to-end phụ thuộc trực tiếp vào description dev viết trong `/tools/list` response.

### Rules

1. **Verb + Noun + Purpose** structure — VD `"Block IP address from accessing a domain by creating WAF rule"`
2. **Include use case triggers** — dùng phrase `"Use this tool when user asks to..."` + list nhiều synonyms
3. **Cover user vocabulary synonyms** — user gõ "chặn/block/deny/ban/prevent" — description phải chứa các keyword này
4. **Distinguish similar tools** — `create_waf` vs `create_rate_limit` description phải khác rõ ràng
5. **Cross-lingual OK** — user Việt gõ "chặn IP", description Anh "block IP" là đủ (LLM cross-lingual mạnh) — NHƯNG cần đủ context từ khoá
6. **Include return shape hints** — VD `"Returns log entries with timestamp, source IP, method, path, status code"`
7. **Param descriptions cũng critical** — thêm format hints (`"VD: foo.com, not full URL"`) và behavior hints (`"Omit to block all IPs"`)

### Real case study — smoke test 2026-09-18

**❌ Description ban đầu (LLM fail):**
```
"Create WAF rule blocking IP/domain"
```

**Prompt user:** `"Chặn IP 5.6.7.8 truy cập smoke-test.foo.com"`

**Kết quả LLM (Sonnet 5):** không gọi tool, trả generic Nginx/Apache config advice. Backend log confirm `tools/list` đã trả về đủ tools nhưng `tools/call` KHÔNG được emit — LLM không match được "chặn IP" với "WAF rule" (term "WAF" quá abstract cho user vocabulary).

**✅ Description sau khi improve (LLM pass):**
```
"Block an IP address from accessing a domain by creating a WAF (Web
Application Firewall) rule. Use this tool when user asks to block,
deny, ban, prevent, or firewall an IP/CIDR from accessing a
website/domain/subdomain. Handles both individual IPs and IP ranges."
```

**Cùng prompt, kết quả:** Claude gọi ngay `create_waf` → mock trả `waf_id` → Claude echo `"Đã chặn thành công. IP 5.6.7.8 giờ bị block khi truy cập smoke-test.foo.com (WAF rule ID: waf-mock-...)"`

**Key techniques dùng trong fix:**
- Explicit trigger phrase: `"Use this tool when user asks to..."`
- Synonym cluster: `"block, deny, ban, prevent, firewall"` — cover đủ user vocabulary
- Contextual expansion: `"(Web Application Firewall)"` — giúp LLM link WAF ↔ block IP
- Scope hint: `"individual IPs and IP ranges"` — help LLM know input format

### Examples good vs bad

| ❌ Bad | ✅ Good | Vì sao |
|---|---|---|
| `"Create WAF"` | `"Block an IP from accessing a domain by creating a WAF rule. Use when user asks to block/deny/ban/firewall an IP."` | Bad thiếu action + verb; Good có synonym cluster |
| `"WAF endpoint"` | `"Query recent HTTP access log entries for a domain. Use when user asks to see traffic, investigate suspicious requests, or debug 404/500 errors."` | Bad chỉ nói loại; Good có 3 use case triggers |
| `"POST /waf/rules"` | `"List all active WAF rules with optional filter by domain. Returns rule ID, target domain, blocked IPs."` | Bad là technical URL; Good có return shape |
| `"Handles rate limit"` | `"Set a rate limit policy for a domain (max requests per second). Use when user asks to throttle, rate-limit, restrict traffic. Requests exceeding limit receive HTTP 429."` | Bad vague verb; Good có synonyms + output behavior |

---

## 7. Test protocol — verify description trước khi ship endpoint mới

**Bắt buộc:** trước khi ship endpoint mới vào prod `/tools/list`, dev phải verify description LLM chọn được tool đúng. **~5 phút / endpoint.**

### Step 1: Curl-test `/tools/list` — verify serve đúng schema

```bash
curl -H "Authorization: Bearer $ONEMCP_BEARER" \
     https://osh-admin.your-domain/tools/list | jq '.tools[] | select(.name=="YOUR_NEW_TOOL_NAME") | {name, description, permission_id}'
```

Verify description đủ dài (recommend ≥50 chars) + có synonym cluster + có use case trigger.

### Step 2: Test LLM tool selection với 3-5 prompts

Trong Claude Desktop (dev environment với `onemcp-local`):

1. **New chat** (Ctrl+N) sau khi endpoint mới đã được OneMCP discover (chờ 60s hoặc click Refresh cache)
2. Test **5 prompts realistic** với vocabulary khác nhau — không dùng tên tool explicit:

**Ví dụ cho `create_waf`:**
```
✓ Chặn IP 1.2.3.4 truy cập example.com
✓ Block IP 5.6.7.8 from accessing foo.com
✓ Deny access từ 10.0.0.0/24 cho subdomain api.example.com
✓ Không cho IP 8.8.8.8 vào domain bar.com
✓ Ban IP address 192.168.1.1 on site.com
```

**Expected:** Claude gọi `create_waf` cho cả 5 prompts. Nếu ≥1 prompt LLM trả generic answer → **description chưa đủ tốt, quay lại improve.**

3. Test **edge cases** với vocabulary user thực tế của team dùng — hỏi 1-2 người non-dev thử prompt

### Step 3: Verify từ backend log

Check OneMCP backend log — mỗi test prompt phải có `mcp-method: tools/call` với `name: YOUR_NEW_TOOL_NAME`:

```bash
docker logs onemcp-backend-1 --since 5m 2>&1 | grep -E "tools/call|mcp-method" | tail -10
```

**Nếu chỉ thấy `tools/list` calls (không có `tools/call`):** LLM đọc tools nhưng không chọn → description issue.

### Step 4: Regression — verify tool khác không bị "steal"

Test 3 prompts thuộc **tool KHÁC** — verify LLM vẫn chọn đúng, không bị description mới "steal" prompts của tool cũ:

```
✓ "Xem access log của foo.com" → phải gọi query_access_log, KHÔNG phải create_waf
✓ "Rate limit domain bar.com 100 req/s" → phải gọi create_rate_limit
```

Nếu bị steal → 2 descriptions quá similar → cần distinguish rõ hơn.

### Common failure patterns

| Symptom | Root cause | Fix |
|---|---|---|
| LLM trả generic answer, không gọi tool | Description quá abstract/technical | Thêm synonym cluster + trigger phrase |
| LLM chọn sai tool (VD `query_access_log` thay vì `create_waf`) | 2 descriptions overlap semantic | Distinguish rõ verbs (query vs create/block) |
| LLM gọi tool nhưng params sai | Param descriptions thiếu format hints | Thêm example values + behavior hints |
| Prompt tiếng Việt fail, tiếng Anh pass | Description thiếu keyword universal | Include English keywords (block/deny/ban) — LLM cross-lingual sẽ tự map |

---

## 8. Testing checklist (RBAC + E2E)

### 8.1. Verify `/tools/list`

```bash
# Không bearer → 401
curl -i https://osh-admin.your-domain/tools/list

# Với bearer → 200 + valid JSON
curl -H "Authorization: Bearer $ONEMCP_BEARER" \
     https://osh-admin.your-domain/tools/list | jq .
```

Verify: `app_slug=osh_admin`, `version` semver, mỗi tool đúng schema.

### 8.2. Verify `.well-known/rbac-permissions.json`

```bash
curl https://osh-admin.your-domain/.well-known/rbac-permissions.json | jq .
```

Expect: valid JSON với `permissions[]` + `default_roles[]`. Yêu cầu Central admin apply.

### 8.3. Verify RBAC middleware

```bash
# Missing X-Onemcp-User-Sub → 401
curl -X POST -H "Authorization: Bearer $ONEMCP_BEARER" \
     https://osh-admin.your-domain/waf/rules
# Expect: 401 "missing X-Onemcp-User-Sub"

# User KHÔNG có permission → 403
curl -X POST \
     -H "Authorization: Bearer $ONEMCP_BEARER" \
     -H "X-Onemcp-User-Sub: user-without-perm" \
     -d '{"domain":"foo.com"}' \
     https://osh-admin.your-domain/waf/rules
# Expect: 403 "forbidden, missing_permission: osh_admin:tool.create_waf"

# User CÓ permission → 200
curl -X POST \
     -H "Authorization: Bearer $ONEMCP_BEARER" \
     -H "X-Onemcp-User-Sub: user-with-operator-role" \
     -d '{"domain":"foo.com"}' \
     https://osh-admin.your-domain/waf/rules
# Expect: 200 { waf_id: '...' }
```

### 8.4. Verify E2E qua Claude Desktop (sync với anh Trí)

1. OneMCP admin register upstream `osh_admin` prod
2. Central admin assign role `osh_admin.operator` cho user test
3. User test đăng nhập Claude Desktop, chọn MCP server `onemcp`
4. Chat: "Chặn IP 5.6.7.8 cho foo.com"
5. Expect: Claude gọi `create_waf` → osh_admin RBAC pass → trả `waf_id` → Claude echo kết quả
6. Test negative: assign role `osh_admin.viewer` (chỉ có `query_access_log`) → gọi `create_waf` → expect 403 forbidden
7. Verify correlation ID chain trong logs 3 systems: OneMCP audit + osh_admin log + Central RBAC log

---

## 9. References

- **OneMCP bridge discovery spec (full):** [`onemcp-bridge-discovery-spec.md`](./onemcp-bridge-discovery-spec.md) — 509 lines, chi tiết endpoint contract + 4 code examples (Express/NestJS/Go/Python)
- **Workflow mockup HTML:** [`mockups/onemcp-osh-admin-bridge-workflow.html`](../mockups/onemcp-osh-admin-bridge-workflow.html) — visual overview 2 systems
- **Central RBAC client SDK:** `d:/Vietnt/Project/onelog/central-rbac-client/nodejs`

## Contact

- **OneMCP owner + Central RBAC owner:** trihd@inet.vn (anh Trí)
- **Deliver credentials qua:** Bitwarden/1Password vault (không email/chat)

## Unresolved / open questions

- Exposure model (LAN vs Public vs Hybrid) — chờ dev osh_admin confirm để OneMCP quyết định có cần HMAC signed header không (nếu Public → +1-2d cả 2 sides)
- Timeline dev osh_admin done 6 items — estimate ~1-2 tuần, cần confirm để OneMCP schedule P5d prod swap
