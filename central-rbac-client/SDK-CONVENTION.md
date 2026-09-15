# SDK Convention — Cross-SDK consistency (Node ↔ Python)

**Purpose**: Đảm bảo dev đọc 1 SDK là hiểu SDK còn lại. Concept keyword identical,
case convention idiomatic to each language.

---

## 1. Naming rule

| Layer | Node.js | Python | Rationale |
|---|---|---|---|
| Concept keyword | `checkPermission` | `check_permission` | Same verb+noun, different case |
| Config field | `centralUrl` | `central_url` | Same name, different case |
| Env var | `CENTRAL_URL` | `CENTRAL_URL` | Same across all stacks |
| Error code | `RBAC_INVALID_TOKEN` | `RBAC_INVALID_TOKEN` | UPPER_SNAKE, same string |
| Package name | `@onelog/central-rbac-client` | `onelog-central-rbac-client` | npm scoped ↔ pypi kebab |
| Class | `CentralRbacClient` | `CentralRbacClient` | PascalCase in both |

**Rule**: If concept is same, method name is same (modulo case). Do NOT rename during translation.

---

## 2. API surface mapping

### Client class

| Node | Python | Return | Notes |
|---|---|---|---|
| `new CentralRbacClient(config)` | `CentralRbacClient(**config)` | instance | Python uses kwargs |
| `client.resolve(userSub, tenantId?)` | `client.resolve(user_sub, tenant_id=None)` | `ResolveResponse` | Async in both |
| `client.checkPermission(sub, key, tid?)` | `client.check_permission(sub, key, tid=None)` | `PermissionCheck` | |
| `client.getEpoch()` | `client.get_epoch()` | `int` | |
| `client.flushCache()` | `client.flush_cache()` | `None` | |
| `client.close()` | `client.close()` | `None` | Both stop poller |

### Framework adapters

| Framework | Node | Python |
|---|---|---|
| Fastify (Node) | `app.register(centralRbacFastify, config)` then `app.rbac.requirePermission('key')` | N/A |
| Express (Node) | `app.use(centralRbacExpress(config))` then `centralRbacExpress.requirePermission('key')` | N/A |
| FastAPI (Python) | N/A | `Depends(require_permission('key'))` |
| Django (Python) | N/A | `@require_permission('key')` decorator |
| Flask (Python) | N/A | `@rbac.require_permission('key')` |

**Convention**: `requirePermission` (Node camelCase) ↔ `require_permission` (Python snake). Same string in framework-native syntax.

---

## 3. Config fields (mapping)

| Node field | Python field | Env var | Default | Notes |
|---|---|---|---|---|
| `centralUrl` | `central_url` | `CENTRAL_URL` | — required | Trailing slash stripped |
| `appSlug` | `app_slug` | `APP_SLUG` | — required | |
| `centralRbacToken` | `central_rbac_token` | `CENTRAL_RBAC_TOKEN` | — required | Per-app format warn |
| `cacheTtlSec` | `cache_ttl_sec` | `RBAC_CACHE_TTL_SEC` | 60 | |
| `cacheMaxEntries` | `cache_max_entries` | `RBAC_CACHE_MAX` | 5000 | |
| `epochPollIntervalSec` | `epoch_poll_interval_sec` | `RBAC_EPOCH_POLL_SEC` | 10 | |
| `circuitBreakerThreshold` | `circuit_breaker_threshold` | `RBAC_CB_THRESHOLD` | 5 | |
| `circuitBreakerResetSec` | `circuit_breaker_reset_sec` | `RBAC_CB_RESET_SEC` | 30 | |
| `requestTimeoutMs` | `request_timeout_ms` | `RBAC_TIMEOUT_MS` | 500 | Max 5000 |
| `failMode` | `fail_mode` | `RBAC_FAIL_MODE` | `'closed'` | `'closed'` \| `'open'` |
| `logger` | `logger` | — | `None`/noop | Pino / logging.Logger |

---

## 4. Error codes (shared taxonomy)

All 10 codes identical string across both SDKs. See [`SPEC.md`](SPEC.md) §3.

**Convention**: Error class name = `CentralRbacError` in both. Attribute:
- Node: `error.code`, `error.httpStatus`, `error.cause`
- Python: `err.code`, `err.http_status`, `err.__cause__`

---

## 5. Response type mapping

| Node interface | Python type | Field naming |
|---|---|---|
| `ResolveResponse` | `ResolveResponse` (TypedDict/pydantic) | snake_case fields (wire format) |
| `PermissionCheck` | `PermissionCheck` | snake_case wire, method returns camelCase for backward compat |
| `EpochResponse` | `EpochResponse` | snake_case |

**Rule**: Wire format (JSON on the wire) is snake_case both sides. In-language field access follows language convention:
- Node: `response.effective_roles` (accept snake in response object — matches Central schema)
- Python: `response['effective_roles']` or `response.effective_roles` (pydantic)

---

## 6. Version alignment

**Rule**: Both SDKs bump same semver together on Central release.

Example rollout (plan 260910-1334 cadence):
- Central v2.0.1 → Node SDK 0.2.0 + Python SDK 0.2.0 (aligned)
- Central v2.1.0 (delegation) → Node 0.3.0 + Python 0.3.0
- SDK-only patch (bug fix Node) → Node 0.2.1 + Python 0.2.1 (still aligned, even if Python no-op)

**Why**: Version alignment = single source of truth for "which Central protocol version this SDK speaks". Even if only 1 SDK changes, bump both — cheap for maintainer, clear for consumer.

**Enforce**: Top-level [`CHANGELOG.md`](CHANGELOG.md) tracks aligned version; per-SDK CHANGELOGs (`nodejs/CHANGELOG.md`, `python/CHANGELOG.md`) can add stack-specific notes.

---

## 7. Conformance

Any new SDK MUST pass [`CONFORMANCE_TESTS/`](CONFORMANCE_TESTS/) 20 scenarios. If Python passes but Node fails scenario X → Node is buggy. If both fail → SPEC.md needs clarification (open issue).

---

## 8. When to diverge (allowed)

- Language idioms: Node uses `Promise`, Python uses `async def` + `await`
- Type system: Node interfaces, Python TypedDict/pydantic
- Framework naming: Express `use()`, Fastify `register()`, FastAPI `Depends()` — these are framework conventions, keep native
- Test runner: vitest (Node), pytest (Python) — no need to align

**Not allowed to diverge**: method names, config field names (modulo case), error codes, cache key format, defaults.

---

## 9. Related

- [`SPEC.md`](SPEC.md) — protocol contract
- [`SECURITY_INVARIANTS.md`](SECURITY_INVARIANTS.md) — MUST rules
- [`AGENTS.md`](AGENTS.md) — AI agent integration
- Per-SDK: `nodejs/README.md`, `python/README.md` (Phase 4 onward)
