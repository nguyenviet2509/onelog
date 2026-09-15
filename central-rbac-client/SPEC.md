# Central RBAC v2 Protocol Specification

**Version**: 2.0 | **SDK compat**: 0.x | **Central compat**: v2.0.1+
**Reference impl**: [`nodejs/src/client.ts`](nodejs/src/client.ts) là gold reference.

> Contract giữa Central RBAC backend và all SDK implementations (Node, Python, future).
> Any SDK MUST honor sections marked **MUST**. Diverge = non-conformant.

---

## 1. Endpoints

### 1.1 `POST /v2/resolve` — Resolve user permissions

**Purpose**: SDK gọi để lấy full effective_roles + permissions của 1 user trong app scope.

**Request**:
```http
POST /v2/resolve HTTP/1.1
Host: rbacnb.000nethost.com
Content-Type: application/json
X-Rbac-Token: rbac_<8char>_<24char>       # per-app token (SDK MUST send)

{
  "user_sub": "389119343390097411",       # Zitadel user ID (string)
  "app_slug": "helpdesk",                 # MUST match token's app scope
  "tenant_id": "dept-hr" | null           # optional; scope role bindings by tenant
}
```

**Response 200**:
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Api-Version: 2                          # SDK MUST verify header = "2"

{
  "user_sub": "389119343390097411",
  "app_slug": "helpdesk",
  "tenant_id": "dept-hr",
  "effective_roles": ["helpdesk.agent", "helpdesk.viewer"],
  "permissions": ["helpdesk:tickets.read", "helpdesk:tickets.reply"],
  "epoch": 42,                            # monotonic counter per app
  "cached": false                         # Central-side cache hit flag
}
```

**Error responses**: xem section 3.

---

### 1.2 `GET /v2/epoch/:app_slug` — Fetch current epoch

**Purpose**: SDK background poller fetch epoch periodically. Nếu epoch tăng → SDK MUST flush cache.

**Request**:
```http
GET /v2/epoch/helpdesk HTTP/1.1
Host: rbacnb.000nethost.com
X-Rbac-Token: rbac_<8char>_<24char>
```

**Response 200**:
```http
HTTP/1.1 200 OK
X-Api-Version: 2

{
  "app_slug": "helpdesk",
  "epoch": 42,
  "cached": true
}
```

**Epoch semantics**:
- Monotonic counter per `app_slug`
- Incremented by Central on: role grant, role revoke, permission change, membership change
- SDK MUST poll every ≤10s (default) and compare to last-known
- Change detected → SDK MUST `cache.clear()` before next resolve

---

### 1.3 `POST <app-webhook>/rbac/notify-revoke` — Push invalidation *(optional)*

**Purpose**: Central push epoch change đến app webhook cho instant revoke propagation. Fallback: SDK polling handles nếu webhook fails.

**Request** (Central → app):
```http
POST /rbac/notify-revoke HTTP/1.1
Content-Type: application/json
X-Rbac-Notify-Signature: sha256=<hex>     # HMAC-SHA256(body, webhook_secret)

{
  "app_slug": "helpdesk",
  "epoch": 43,
  "reason": "role_revoked" | "role_granted" | "user_disabled",
  "affected_user_sub": "389119343390097411" | null,
  "ts": "2026-09-15T13:37:00.000Z"
}
```

**App response**: 200 OK (empty body). SDK invokes `flushCache()` on notify.

**Signature verify**: SDK MUST verify `X-Rbac-Notify-Signature` before flush. Ignore invalid signatures.

---

## 2. SDK behavior contracts

### 2.1 Cache

- **Backend**: in-memory LRU (Node: `lru-cache`, Python: `cachetools.LRUCache`)
- **Key format**: `sha256(user_sub + '|' + app_slug + '|' + (tenant_id ?? 'NULL'))`
  - MUST include `app_slug` để multi-instance (1 process, N clients) không cross-contaminate
  - MUST use `'NULL'` literal khi `tenant_id` là null (not empty string)
- **TTL**: default 60s (configurable via `cacheTtlSec`/`cache_ttl_sec`)
- **Max entries**: default 5000 (configurable)
- **Invalidation trigger**:
  1. TTL expire (LRU natural)
  2. Epoch change detected by poller → `cache.clear()`
  3. Webhook notify-revoke received → `cache.clear()`
  4. Explicit `flushCache()`/`flush_cache()` call

### 2.2 Circuit breaker

**3-state machine**:
```
CLOSED ──5 consecutive failures──→ OPEN
OPEN ──30s reset timer──→ HALF_OPEN
HALF_OPEN ──1 success──→ CLOSED
HALF_OPEN ──1 failure──→ OPEN (reset timer restart)
```

- **Threshold**: 5 consecutive failures (configurable `circuitBreakerThreshold`)
- **Reset**: 30s (configurable `circuitBreakerResetSec`)
- **State OPEN behavior**:
  - `failMode='closed'` (default): throw `RBAC_CIRCUIT_OPEN`
  - `failMode='open'` (DEV ONLY): return empty roles/permissions, log `SDK_FAILOPEN_BYPASS` warn
- **State HALF_OPEN**: allow 1 probe request; success → CLOSED, failure → OPEN

### 2.3 Epoch poller

- Background task (Node: setInterval, Python: asyncio.create_task loop)
- Fetch `GET /v2/epoch/:app_slug` mỗi `epochPollIntervalSec` (default 10s)
- On change: log info + `flushCache()`
- On error: log warn, retain last-known epoch, retry next tick
- MUST stop on `close()` call

### 2.4 Request timeout

- Default 500ms per call (configurable `requestTimeoutMs`)
- MUST use `AbortController` (Node) / `httpx.Timeout` (Python)
- Timeout counts as circuit breaker failure

### 2.5 Fail modes

| Mode | Prod allowed | Circuit OPEN | HTTP error | Use case |
|---|---|---|---|---|
| `closed` (default) | ✅ | throw `RBAC_CIRCUIT_OPEN` | throw error | Production |
| `open` | ❌ **hard reject at construct** | return empty perms | return empty perms | Dev/local only |

**MUST hardcoded guard**: SDK constructor check `NODE_ENV=production` / `ENV=production` — throw `RBAC_SDK_CONFIG_ERROR` nếu `failMode=open` in prod. No override.

### 2.6 Version handshake

- Every response MUST include `X-Api-Version: 2`
- SDK MUST verify header:
  - `= '2'` → OK
  - `= undefined` → accept (backward compat during rollout)
  - `= '1'` or other → throw `RBAC_MANIFEST_MISMATCH`

### 2.7 Token format

- Per-app format: `rbac_[a-z0-9]{8}_[a-z0-9]{24}` (post-plan 260915-0830)
- Legacy shared format: opaque string (accepted until 2028-01-01)
- SDK MUST warn at init if token không match per-app regex (do not fail)
- SDK MUST NOT log full token — only prefix 8 chars max

---

## 3. Error taxonomy (shared 10 codes)

| Code | Meaning | Trigger | Retry safe? |
|---|---|---|---|
| `RBAC_SDK_CONFIG_ERROR` | Bad config | Missing centralUrl/appSlug/token OR prod+failMode=open | ❌ (fix code) |
| `RBAC_CENTRAL_UNREACHABLE` | Network timeout/DNS/refused | undici/httpx network error | ✅ (CB) |
| `RBAC_CENTRAL_5XX` | Central 5xx | 500-599 status | ✅ (CB) |
| `RBAC_CENTRAL_4XX` | Central 4xx (non-401/404) | 400-499 status | ❌ (fix request) |
| `RBAC_CIRCUIT_OPEN` | CB open, request rejected | 5 consecutive fails | ⏸ (wait reset) |
| `RBAC_MANIFEST_MISMATCH` | X-Api-Version ≠ 2 | Central returned v1 header | ❌ (upgrade Central) |
| `RBAC_INVALID_TOKEN` | 401 from Central | Token revoked/wrong | ❌ (rotate token) |
| `RBAC_APP_NOT_FOUND` | 404 from Central | app_slug not registered | ❌ (register app) |
| `RBAC_PERMISSION_DENIED` | checkPermission returned false | User lacks role/perm | N/A |
| `RBAC_INTERNAL_ERROR` | Unknown/unexpected | Fallback | ❌ (report bug) |

**Error object contract**:
- `code`: 1 of above (string)
- `message`: human-readable, MAY include URL/appSlug (never token)
- `httpStatus?`: number if HTTP-triggered
- `cause?`: original error object (nếu wrapped)

---

## 4. Version compatibility

| Central version | SDK version range | Notes |
|---|---|---|
| v2.0.1 (2026-09-15) | 0.2.x | Per-app tokens + `/v2/resolve` + `/v2/epoch` |
| v2.1.x (planned) | 0.3.x | Delegation grants (plan 260910-1334 Phase 8) |
| v3.x (future) | 1.x | Breaking — separate track |

**Rule**: Central v2.x accepts SDK 0.y where y ≤ Central minor. SDK MUST send `X-Rbac-Client-Version: <sdk-version>` in future release (currently omitted).

---

## 5. Reference implementation checklist

Anyone implementing a new SDK MUST match:

- [ ] `resolve(user_sub, tenant_id?)` → `ResolveResponse`
- [ ] `check_permission(user_sub, permission_key, tenant_id?)` → `PermissionCheck`
- [ ] `get_epoch()` → int
- [ ] `flush_cache()` → void
- [ ] `close()` → void (stop poller)
- [ ] LRU cache with SHA256 key format above
- [ ] Circuit breaker 3-state (5 fail / 30s reset)
- [ ] Epoch poller background task
- [ ] X-Api-Version verify
- [ ] Production fail-open hard guard
- [ ] All 10 error codes surfaced
- [ ] Framework adapter idiomatic (Fastify plugin / FastAPI Depends / Flask decorator)

**Reference**: `nodejs/` implementation is the canonical behavior. If Python differs, Python is wrong.

---

## 6. Related docs

- [`SECURITY_INVARIANTS.md`](SECURITY_INVARIANTS.md) — MUST rules for security
- [`SDK-CONVENTION.md`](SDK-CONVENTION.md) — Node ↔ Python API mapping
- [`AGENTS.md`](AGENTS.md) — AI agent integration guide
- [`CONFORMANCE_TESTS/`](CONFORMANCE_TESTS/) — 20 scenarios enforce this spec
