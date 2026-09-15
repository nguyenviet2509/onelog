# Conformance Scenarios — Central RBAC SDK

**Purpose**: 20 scenarios plain English defining what ANY Central RBAC SDK MUST do.
Node runner + Python runner both target these scenarios.

**Rule**: If runner fails scenario X → SDK is non-conformant, fix SDK.
If both runners fail scenario X → [`SPEC.md`](../SPEC.md) needs clarification.

---

## Group A — Authentication (4 scenarios)

### A1. Per-app token format accepted
- **Given**: SDK init with `centralRbacToken = 'rbac_ab12cd34_efgh5678ijkl9012mnop3456'` (matches `^rbac_[a-z0-9]{8}_[a-z0-9]{24}$`)
- **When**: `resolve()` called
- **Then**: Central receives `X-Rbac-Token: rbac_ab12cd34_efgh5678ijkl9012mnop3456`. No warn log emitted.

### A2. Invalid token → Central 401 → `RBAC_INVALID_TOKEN`
- **Given**: Central configured reject token as unknown
- **When**: `resolve()` called → Central returns 401
- **Then**: SDK throws `CentralRbacError` with `code='RBAC_INVALID_TOKEN'`, `httpStatus=401`

### A3. Missing token → constructor `RBAC_SDK_CONFIG_ERROR`
- **Given**: Init config `centralRbacToken = ''` (empty string)
- **When**: `new CentralRbacClient(config)`
- **Then**: Throws `CentralRbacError` with `code='RBAC_SDK_CONFIG_ERROR'`, message includes "centralRbacToken required"

### A4. Legacy shared token grace-period warn
- **Given**: Init config `centralRbacToken = 'abcdef1234567890'` (does not match per-app regex)
- **When**: `new CentralRbacClient(config)`
- **Then**: 1 warn log emitted containing text `legacy` or `per-app format`. Constructor does NOT throw. SDK operates normally.

---

## Group B — Cache (5 scenarios)

### B1. First request → cache miss → Central call → cache stored
- **Given**: Fresh SDK instance, empty cache
- **When**: `resolve('user-1', null)` called
- **Then**: Mock Central receives 1 POST to `/v2/resolve`. Response has `cached: false`. Cache size = 1.

### B2. Second request within TTL → cache hit → no Central call
- **Given**: Cache warmed by B1
- **When**: `resolve('user-1', null)` called again within 60s
- **Then**: Mock Central call count unchanged (still 1). Response has `cached: true`.

### B3. Different `tenant_id` → separate cache entry
- **Given**: `resolve('user-1', 'dept-a')` cached
- **When**: `resolve('user-1', 'dept-b')` called
- **Then**: Mock Central receives new POST. Cache size = 2.

### B4. Epoch bump detected → cache flushed → next resolve → cache miss
- **Given**: Cache warmed with epoch=1
- **When**: Mock Central bumps epoch to 2, poller ticks, then `resolve('user-1', null)` called
- **Then**: Mock Central receives new POST (cache miss after flush). Response reflects epoch=2.

### B5. Manual `flushCache()` → next resolve → cache miss
- **Given**: Cache warmed with 1 entry
- **When**: `client.flushCache()` then `resolve('user-1', null)`
- **Then**: Mock Central receives new POST. Cache size after resolve = 1.

---

## Group C — Circuit breaker (4 scenarios)

### C1. 5 consecutive failures → circuit opens
- **Given**: Mock Central returns 500 for all requests
- **When**: 5 calls to `resolve()` fail in row
- **Then**: 6th call throws `RBAC_CIRCUIT_OPEN` immediately, no HTTP call made. Mock Central saw exactly 5 requests.

### C2. Circuit open → subsequent calls throw without HTTP
- **Given**: Circuit opened by C1
- **When**: `resolve()` called immediately
- **Then**: Throws `RBAC_CIRCUIT_OPEN`, Mock Central request count unchanged.

### C3. After reset timeout → half-open state → 1 probe allowed
- **Given**: Circuit opened, reset timer set 200ms (test override)
- **When**: Wait 210ms, call `resolve()`
- **Then**: Exactly 1 HTTP request made (probe). If succeeds → circuit closes.

### C4. Probe success → circuit closed → normal operation resumes
- **Given**: Circuit half-open (from C3), Mock Central now returns 200
- **When**: Probe succeeds, then 3 more `resolve()` calls
- **Then**: All 4 requests succeed. Circuit state = closed.

---

## Group D — Security invariants (4 scenarios)

### D1. Production + `failMode='open'` → constructor throws
- **Given**: `process.env.NODE_ENV = 'production'`, config `failMode: 'open'`
- **When**: `new CentralRbacClient(config)`
- **Then**: Throws `CentralRbacError` code `RBAC_SDK_CONFIG_ERROR`, message contains "failMode=open" and "production" (or "DEV ONLY")

### D2. Central 5xx + failMode=closed (default) → fail-close
- **Given**: Production env, `failMode` default (closed), Central returns 500
- **When**: `resolve()` called
- **Then**: Throws `CentralRbacError` code `RBAC_CENTRAL_5XX`. Does NOT return empty roles.

### D3. Log output never contains full token
- **Given**: Spy logger captures all messages
- **When**: Various operations: init with legacy token (warn), Central 401 (error log), circuit open (warn)
- **Then**: NO log message contains full token value `rbac_ab12cd34_efgh5678ijkl9012mnop3456`. Log may contain `appSlug`, error codes, URLs — never token.

### D4. Response header `X-Api-Version` mismatch → `RBAC_MANIFEST_MISMATCH`
- **Given**: Mock Central returns `X-Api-Version: 1` in response
- **When**: `resolve()` called
- **Then**: Throws `CentralRbacError` code `RBAC_MANIFEST_MISMATCH`. Cache not populated.

---

## Group E — Behavior (3 scenarios)

### E1. Epoch poller runs background, fetches epoch every `epochPollIntervalSec`
- **Given**: SDK init with `epochPollIntervalSec = 0.1` (100ms for test)
- **When**: Wait 350ms
- **Then**: Mock Central `/v2/epoch/:app_slug` called ≥3 times.

### E2. `resolve()` returns full shape `{user_sub, app_slug, tenant_id, effective_roles, permissions, epoch, cached}`
- **Given**: Mock Central returns valid response
- **When**: `resolve('user-1', 'dept-a')` called
- **Then**: Return value has all 7 keys with correct types (strings, arrays, number, boolean).

### E3. `close()` stops poller + clears cache
- **Given**: SDK warmed with cache + poller running
- **When**: `client.close()` called, then wait 500ms
- **Then**: Mock Central epoch poll count unchanged (poller stopped). Cache emptied (or client marked closed, does not serve stale).

---

## Runner outputs

Runner MUST report:
- Total scenarios: 20
- Passed / Failed / Skipped counts
- Per-group breakdown (A/B/C/D/E)
- Duration <30s wall clock

Exit code 0 on 20/20 pass, 1 otherwise.

---

## Version tracking

| Scenarios version | SDK compat | Notes |
|---|---|---|
| 1.0 (2026-09-15) | 0.2.x | Initial 20 scenarios |

Change scenarios only via SPEC.md update. Bump scenarios version + both SDK runners.
