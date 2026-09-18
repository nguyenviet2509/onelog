# osh_admin integration handoff — OneMCP

**Mục đích:** hướng dẫn dev osh_admin implement các phần cần thiết để osh_admin backend expose tools cho **OneMCP** (MCP server cho Claude Desktop).

**Audience:** dev osh_admin.

**Effort estimate:** ~2-4 giờ tổng cộng (MVP không cần RBAC integration).

**Trạng thái phía OneMCP:** ✅ shipped 2026-09-18 — hoàn toàn sẵn sàng. Chờ osh_admin done các item bên dưới.

---

## 1. TL;DR — cần deliver 4 thứ

| # | Item | Effort |
|---|---|---|
| A | Expose `GET /tools/list` endpoint (bearer-protected) | ~30 phút |
| B | Verify bearer S2S trên các endpoint tool call | ~15 phút |
| C | Deploy osh_admin lên prod endpoint URL | tùy setup |
| D | Cấp base URL prod + bearer token cho OneMCP admin | ~5 phút |

Sau khi done → OneMCP admin register upstream ~15 phút → tools live trong Claude Desktop.

**Note MVP:** phần RBAC per-user (SDK Central RBAC + middleware verify user permissions) **DEFER Phase 2**. MVP tin cậy tất cả users authenticated qua OneMCP có full access osh_admin tools (users hiện tại = admins nội bộ INET, số lượng ít).

---

## 2. Big picture — 30 giây

```
┌─────────────────┐     MCP tools/call      ┌──────────────┐    HTTP+Bearer     ┌──────────────┐
│ Claude Desktop  │ ──────────────────────► │   OneMCP     │ ─────────────────► │  osh_admin   │
│ (LLM agent)     │     with Bearer         │ (pure proxy) │  + X-User-Sub      │  (BẠN đây)   │
└─────────────────┘                         └──────────────┘                     └──────────────┘
                                                    │
                                                    │ live-fetch (mỗi 60s)
                                                    │ GET /tools/list
                                                    ▼
                                            ┌──────────────┐
                                            │  osh_admin   │
                                            │  /tools/list │
                                            └──────────────┘
```

**Nguyên tắc:**
- OneMCP = **pure proxy** — forward `X-Onemcp-User-Sub` (Zitadel sub) + `Authorization: Bearer` + `X-Onemcp-Correlation-Id`
- osh_admin = **tool executor** — verify bearer S2S + thực hiện business logic + log audit
- Không share DB/library giữa 2 systems, chỉ HTTP contract

**Trust model MVP:** bất kỳ user nào authenticate qua Claude Desktop OAuth (Zitadel) đều gọi được tất cả tools osh_admin. Bearer S2S check giữa OneMCP ↔ osh_admin đảm bảo request đến từ OneMCP hợp lệ.

---

## 3. Việc cần làm — chi tiết

### Item A: Expose `GET /tools/list` endpoint

**Purpose:** OneMCP fetch endpoint này mỗi 60s (cache TTL) để auto-discover tools mới. Dev osh_admin thêm/sửa endpoint → auto visible trong Claude Desktop ≤60s.

**Contract:**
- URL: `GET ${base_url}/tools/list` (path có thể tùy chọn khác nếu cần, config OneMCP-side)
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
- `tools[].description` = mô tả **cho LLM đọc** để biết khi nào dùng tool (xem best practice cuối doc)
- `tools[].permission_id` = format `${app_slug}:${resource}.${action}` — MVP không dùng gate nhưng vẫn phải cung cấp (structure cho Phase 2)
- `tools[].param_schema` = JSON Schema (type=object, properties, required, additionalProperties=false)
- Tools array: **max 100 items**

**Best practice:** build tools list dynamic từ router registry (không hardcode). Khi dev thêm endpoint mới có metadata `@Tool({...})` decorator → tự động append vào `/tools/list` response → không cần update thủ công.

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
# Không bearer → 401
curl -i https://osh-admin.your-domain/tools/list

# Với bearer → 200
curl -H "Authorization: Bearer $ONEMCP_BEARER" \
     https://osh-admin.your-domain/tools/list | jq .
```

---

### Item B: Verify bearer S2S trên tool endpoints

**Purpose:** đảm bảo requests đến tool endpoints (VD `POST /waf/rules`) chỉ được accept nếu đến từ OneMCP (không public).

**Middleware apply cho tất cả tool endpoints** (áp dụng chung với `/tools/list`):

```javascript
// Middleware verify bearer (reuse cho tất cả endpoints)
app.use('/waf/rules', requireOneMcpBearer);
app.use('/rate-limits', requireOneMcpBearer);
app.use('/access-logs', requireOneMcpBearer);
// hoặc apply global middleware nếu tất cả endpoints đều behind bearer
```

**Log audit** — header `X-Onemcp-Correlation-Id` để trace cross-system:
```javascript
app.use((req, res, next) => {
  const correlationId = req.headers['x-onemcp-correlation-id'] || 'no-corr-id';
  const userSub = req.headers['x-onemcp-user-sub'] || 'no-user-sub';
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    method: req.method,
    path: req.path,
    correlation_id: correlationId,
    user_sub: userSub,
  }));
  next();
});
```

MVP không dùng `user_sub` để gate — chỉ log cho trace. Phase 2 mới thêm SDK Central RBAC gate.

---

### Item C: Deploy prod endpoint

Tùy setup team osh_admin (docker/k8s/systemd). Deliverables cho OneMCP:
- Base URL prod (VD `https://gateway.inet.vn:8443/osh_admin`)
- Đảm bảo endpoint có thể reach từ OneMCP prod (network reachability check)
- Nếu behind firewall/gateway → whitelist OneMCP IP hoặc allow qua public

**Exposure model:** MVP có thể chọn 1 trong 2:

**A. LAN-only** (recommended nếu deploy same VPC với OneMCP)
- IP whitelist middleware osh_admin: chỉ accept từ OneMCP subnet
- Firewall block internet
- Bearer S2S là đủ security

**B. Public** (nếu deploy khác VPC/DC)
- Bearer S2S + HTTPS bắt buộc
- Nên rotate bearer định kỳ (~3-6 tháng)
- Consider IP whitelist tại gateway (VD chỉ allow OneMCP prod IP)

---

### Item D: Deliver credentials cho OneMCP admin (anh Trí)

**Deliverables:**
1. Base URL prod
2. Bearer token dài (**min 32 chars random**) — cùng bearer cho `/tools/list` và tool call endpoints
3. Confirm exposure model (A hay B)
4. Confirm 3 endpoint paths khớp `/tools/list` response bạn expose

**⚠️ Bảo mật:** deliver bearer qua **Bitwarden/1Password vault**, KHÔNG email/Slack/chat.

---

## 4. E2E workflow — happy path

### Setup once

```
Dev osh_admin                                           OneMCP admin
──────────────                                          ────────────
1. Expose GET /tools/list
2. Verify bearer trên tool endpoints
3. Deploy prod endpoint
4. Deliver base URL + bearer ──────────────────────►  Register upstream (~15 phút)
                                                        (base_url + bearer + discovery_url)
                                                        ↓
                                                        OneMCP auto-load bridges (≤60s)
                                                        ↓
                                                        Tools visible trong Claude Desktop
```

### Iterate freely (post-setup)

```
Dev viết endpoint code mới
    ↓
Endpoint auto-append vào GET /tools/list (nếu build dynamic router)
    ↓
Deploy osh_admin
    ↓
OneMCP cache TTL expire (≤60s) HOẶC admin click "Refresh cache" trong portal
    ↓
Tool visible trong Claude Desktop → LLM gọi ngay
```

**Không cần đụng ai khác** — dev osh_admin autonomy 100% với endpoint changes.

### Runtime: mỗi tool call

```
User: "Chặn IP 5.6.7.8 cho foo.com"
    ↓
Claude Desktop (LLM chọn tool create_waf từ description)
    ↓
OneMCP nhận tools/call
    ├─ verify OAuth user
    ├─ validate args vs param_schema (từ /tools/list)
    └─ forward: POST /waf/rules
         + Authorization: Bearer <S2S>
         + X-Onemcp-User-Sub: <zitadel_sub>
         + X-Onemcp-Correlation-Id: <uuid>
         + body: { domain, ip }
    ↓
osh_admin
    ├─ verify bearer ✓
    ├─ (MVP: skip user permission check)
    ├─ execute business logic
    └─ return 201 { waf_id, domain, ip }
    ↓
OneMCP forward response
    ↓
Claude Desktop trả cho user: "Đã chặn IP..."
```

**Latency:** ~50-100ms (không có SDK gate).

---

## 5. Testing checklist

### 5.1. Verify `GET /tools/list`

```bash
# Không bearer → 401
curl -i https://osh-admin.your-domain/tools/list

# Với bearer → 200 + valid JSON
curl -H "Authorization: Bearer $ONEMCP_BEARER" \
     https://osh-admin.your-domain/tools/list | jq .
```

Verify:
- `app_slug` = `osh_admin`
- `version` = semver `x.y.z`
- Mỗi tool: `name` snake_case, `method` in [GET,POST,PUT,DELETE], `path` starts `/`, `param_schema` valid JSON Schema

### 5.2. Verify tool endpoints bearer check

```bash
# Không bearer → 401
curl -X POST https://osh-admin.your-domain/waf/rules

# Với bearer → 200 (nếu request hợp lệ)
curl -X POST \
     -H "Authorization: Bearer $ONEMCP_BEARER" \
     -H "X-Onemcp-User-Sub: test-user-abc" \
     -H "X-Onemcp-Correlation-Id: test-uuid-123" \
     -H "Content-Type: application/json" \
     -d '{"domain":"foo.com"}' \
     https://osh-admin.your-domain/waf/rules
```

### 5.3. Verify E2E qua Claude Desktop (sync với anh Trí)

1. OneMCP admin register upstream `osh_admin` prod
2. User test đăng nhập Claude Desktop, chọn MCP server `onemcp`
3. Chat: "Chặn IP 5.6.7.8 cho foo.com"
4. Expect: Claude gọi `create_waf` → osh_admin trả `waf_id` → Claude echo kết quả
5. Verify correlation ID chain trong logs 2 systems: OneMCP audit + osh_admin log

---

## 6. Best practices — viết tool `description` cho LLM

**Đây là phần CRITICAL** — LLM (Claude) đọc `description` để quyết định khi nào gọi tool. Description viết dở → LLM chọn sai tool hoặc không chọn được.

### Rules

1. **Verb + Noun + Purpose** structure — VD `"Create WAF rule blocking IP/domain"`
2. **Include use case hints** — `"useful when investigating suspicious traffic"`, `"call this to..."`
3. **Distinguish similar tools** — `create_waf` vs `create_rate_limit` description phải khác rõ ràng
4. **Match user vocabulary** — user Việt gõ "chặn IP", description Anh "blocking IP" là đủ (LLM cross-lingual OK)
5. **Param descriptions cũng critical** — thêm format hints (`"VD: foo.com, not full URL"`) và behavior hints (`"Omit to block all IPs"`)

### Examples

| ❌ Bad | ✅ Good |
|---|---|
| `"Create WAF"` | `"Create WAF rule blocking IP/domain"` |
| `"WAF endpoint"` | `"Query recent HTTP access logs — useful when debugging 404 errors or investigating suspicious traffic"` |
| `"POST /waf/rules"` | `"List active WAF rules with optional filter by domain"` |
| `"Handles rate limit"` | `"Set request rate limit for a domain — max requests per second before 429 responses"` |

---

## 7. Phase 2 — RBAC integration (DEFER)

Khi nào cần add:
- Số users OneMCP tăng > 10 hoặc có users external (không phải admins nội bộ)
- Tools osh_admin có tools sensitive/destructive cần phân quyền (VD delete-only cho super-admin)
- Compliance/audit yêu cầu per-user permission check

**Effort estimate Phase 2:** ~1 tuần.

**Sẽ thêm:**
1. Publish `.well-known/rbac-permissions.json` (permissions catalog + default_roles)
2. Register app `osh_admin` trên Central RBAC portal
3. Integrate `central-rbac-client` SDK
4. Middleware verify `X-Onemcp-User-Sub` per-endpoint → gate qua SDK

**Không cần thay đổi:** endpoint contract, `/tools/list`, bearer S2S — Phase 2 chỉ **thêm** layer RBAC gate, không phá cấu trúc MVP.

**Đã có sẵn:** `permission_id` field trong `/tools/list` — Phase 2 sẽ dùng field này match với Central RBAC catalog.

---

## 8. References

- **OneMCP bridge discovery spec (full):** [`onemcp-bridge-discovery-spec.md`](./onemcp-bridge-discovery-spec.md) — 509 lines, chi tiết endpoint contract + 4 code examples (Express/NestJS/Go/Python)
- **Workflow mockup HTML:** [`mockups/onemcp-osh-admin-bridge-workflow.html`](../mockups/onemcp-osh-admin-bridge-workflow.html) — visual overview

## Contact

- **OneMCP owner:** trihd@inet.vn (anh Trí)
- **Deliver credentials qua:** Bitwarden/1Password vault (không email/chat)

## Unresolved / open questions

- Exposure model (LAN vs Public) — chờ dev osh_admin confirm để OneMCP quyết định có cần whitelist IP không
- Timeline dev osh_admin done 4 items — estimate ~2-4 giờ, cần confirm để OneMCP schedule P5d prod swap
