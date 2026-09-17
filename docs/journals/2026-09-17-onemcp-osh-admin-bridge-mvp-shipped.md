---
date: 2026-09-17
type: technical
tags: [onemcp, mcp, rbac, bridge, osh-admin]
project: onemcp + onelog
status: mvp-shipped
---

# OneMCP → osh_admin Bridge MVP Shipped

OneMCP tool bridge framework shipped **MVP-complete** (P1–P5c). Distributed RBAC pattern proven via mock E2E workflow. P5d prod swap deferred pending dev osh_admin endpoint readiness.

## Commits

| Hash | Repo | Phase | Description |
|---|---|---|---|
| `be8ce76` | onemcp | P1 | Registry DB (tool_upstreams, tool_bridges) + Admin CRUD API + bearer encryption (13 files) |
| `0da56e5` | onemcp | P3 | HTTP proxy dispatcher, user_sub forward, MCP tools merge, Path C guard (15 files) |
| `c92bb7b` | onelog | P3 | Bridge alerting rule + dashboard (1 file) |
| `f6fe4ce` | onemcp | P4 | Portal admin UI `/admin/tool-bridges` CRUD + dry-run test modal (12 files) |
| `3784785` | onemcp | P5a-5b | Mock osh-admin server (Express), Dockerfile, docker-compose.dev integration (4 files) |
| `8d3497d` | onelog | P5c | Guideline + runbook docs (3 files) |

## Delivery Summary

**Phase 1 — Registry DB + Admin API (13 files)**
- `tool_upstreams` table: name, base_url, bearer_ciphertext (AES-256-GCM, reuse `TokenCipherService`), timeout_ms, enabled flag
- `tool_bridges` table: upstream_id FK, method/path/param_schema, permission_id, enabled flag
- NestJS CRUD controllers + services, `param-schema.validator.ts` (ajv strict validation)
- Admin permission `onemcp:admin.tool-bridges` gated via RbacGuard
- 15 unit tests (encrypt/decrypt roundtrip) + 15 integration tests (CRUD happy/sad paths) — all pass

**Phase 3 — HTTP Proxy + MCP Dispatch (15 files onemcp + 1 onelog)**
- `HttpProxyClient` service: fetch wrapper with timeout (default 10s, cap 30s), retry-on-5xx (GET only), response cap 1MB streaming
- `BridgeDispatcherService` orchestration: lookup bridge → validate args vs param_schema → decrypt bearer → proxy → audit
- `tools/list` merged with `listEnabled()` — show ALL enabled bridges (no permission filter, distributed check pattern)
- `tools/call` dynamic dispatch: Path C guard (OAuth required for bridges), user_sub forward, 403 propagation, response truncate marker
- Prometheus metrics: `onemcp_bridge_tool_calls_total`, `onemcp_bridge_tool_latency_seconds`, `onemcp_bridge_tool_response_bytes`, `onemcp_bridge_tool_truncated_total`
- Alertmanager rule `onemcp-bridge-tool.yml` — success rate < 90% warning
- 131 integration tests (timeout, retry, cap, path params, Path C block, upstream 403 forward) — all pass

**Phase 4 — Admin UI Portal (12 files)**
- Next.js `/admin/tool-bridges` page with tabs (Upstreams | Bridges)
- Upstream table: create/edit/delete/toggle-enable, bearer input (password type), bearer masked in response
- Bridge table: create/edit/delete/toggle-enable, test-call dry-run modal
- Test-call endpoint `POST /api/admin/tool-bridges/:id/test` — schema validation only (no upstream fetch), optional `?execute=true` for live call (red-danger style, explicit admin confirm)
- JsonSchemaInput component (textarea + live JSON.parse validation, format button)
- Permission gate at FE (visibility) + BE (guard on all endpoints)
- Portal build clean (no symlink UX error in production build — pre-existing Windows issue, not code)

**Phase 5a-5c — Mock + Smoke + Docs (7 files total)**

*Mock Server (Express, dev-only):*
- 4 endpoints: `POST /waf/rules`, `POST /rate-limits`, `GET /access-logs`, `GET /health`
- Fake RBAC gate: hardcoded allow/deny per test user, check `X-Onemcp-User-Sub` header
- Scenario triggers: `?scenario=slow` (15s timeout), `?scenario=5xx` (502 response), `?scenario=large` (2MB body), `?scenario=malformed` (invalid JSON)
- Log headers to stdout (verify `X-Onemcp-User-Sub`, `X-Onemcp-Correlation-Id` forwarding)
- docker-compose.dev.yml integration (service `mock-osh-admin:8080`, internal network, dev-only tag)

*Smoke Test Coverage:*
- Happy path: 3 tools via Claude Desktop with user having all 3 roles — verify MCP dispatch → mock response → Claude
- Negative: user without role — verify 403 from mock + audit denied event logged
- Timeout: `?scenario=slow` (15s upstream delay) → OneMCP abort at 10s timeout → error propagated
- Retry: GET `?scenario=5xx` (502 response) → retry 1x → final error; POST same scenario → no retry (idempotent guard)
- Response cap: GET `?scenario=large` (2MB body) → truncate marker `[...TRUNCATED: ...]` verified, Claude context not OOM
- 403 propagation: upstream return 403 → OneMCP forward message to Claude (no bearer leak)
- Circuit-open simulation: Central RBAC unavailable → OneMCP fail-closed 503 + Alertmanager rule fires ≤ 60s

*Documentation:*
- `onemcp-tool-bridge-guideline.md` — when to add tool, description template, param_schema best practices, permission naming, security checklist, anti-patterns
- `onemcp-tool-bridge-runbook.md` — register via UI, prod swap section, bearer rotation, circuit-open troubleshooting, permission denied debug, correlation ID tracing

## File Count & Test Results

| Phase | Files | Tests | Status |
|---|---|---|---|
| P1 | 13 | 30 (15 unit + 15 integration) | PASS |
| P3 | 15 (onemcp) + 1 (onelog) | 131 integration | PASS |
| P4 | 12 (portal) | TypeScript build clean | PASS |
| P5a-5c | 7 (4 mock + 3 docs) | Manual smoke (Claude Desktop) | PASS |

**Total:** 48 files, 161 tests, 0 failures.

## Deviations (Documented)

1. **`zitadelSub` persistence** — Not written to DB; read from live JWT on each request
   - Rationale: Sensible for MVP (no token cache invalidation complexity), migration column available for future caching
   - No impact on distributed check pattern or audit

2. **Concurrency linter sweep** — `tool-bridges.service.ts` dryRunTest changes swept into P3 commit `0da56e5` via pre-commit linter hook
   - Blame slightly off (marked P3 instead of P4)
   - Functionally correct; no logic issues

## P5d Deferred (External Gate)

Prod swap blocked on dev osh_admin team readiness. Requires:
- App `osh_admin` registered on Central RBAC portal
- Manifest published (3 permissions: `osh_admin:tool.create_waf`, `osh_admin:tool.create_rate_limit`, `osh_admin:tool.query_access_log`)
- Backend SDK integration + `X-Onemcp-User-Sub` header consumption
- Prod endpoint URL + bearer token (encrypted via Portal UI)
- Exposure model confirmed (LAN vs public) — informs M1 red-team fix (IP whitelist vs HMAC signing)

Prod swap itself = ~0.5d: update `tool_upstreams.osh_admin` record via Portal (base_url + bearer), ratify param_schema, smoke, cleanup test artifacts.

## What Went Well

- **Mock-first design unblocked MVP** — no dependency on dev osh_admin for P5a-5c
- **Framework reusable** — not osh_admin-specific; can register any external HTTP API as bridge
- **Distributed RBAC pattern proves** — OneMCP = pure proxy, osh_admin owns permission gate; no token Central in OneMCP needed
- **Response cap + truncate** — streaming design handles large responses safely
- **Metrics instrumented** — Prometheus ready for prod monitoring (success rate, latency, response size, truncation events)

## Watch List (Post-Ship)

1. **Correlation ID tracing** — Verify OneMCP logs + osh_admin logs share same correlation_id for incident debugging
2. **Circuit breaker behavior** — Monitor central-rbac availability; ensure fail-closed 503 fires alert within SLA
3. **Bearer rotation workflow** — After 5d swap, test user-initiated bearer rotation via Portal (decrypt old → encrypt new → save)
4. **LLM tool selection** — Collect feedback on whether descriptions guide LLM correctly (adjust in P2 if needed)
5. **Performance at scale** — Monitor `onemcp_bridge_tool_latency_seconds` p95 as tool call volume ramps

## Post-Ship Followups

1. **User onboarding** — Share runbook with dev osh_admin + on-call ops team
2. **Run smoke plan doc** from `phase-05-osh-admin-integration-smoke.md` section 5b as regression test monthly
3. **Metrics baseline** — Collect 1 week of metrics (calls/day, latency distribution, 5xx rate) to set alert thresholds
4. **P2 backlog** — Consider: HMAC signed `X-Onemcp-User-Sub` (if osh_admin exposed public), per-user rate limiter, auto bearer rotation

## Unresolved

- **osh_admin endpoint exposure timeline** — Coordinate with dev team on when 5d can start
- **P5d param_schema ratification** — Expected rewrite risk if contract drifts from self-drafted; plan accepts this as design trade-off
- **Circuit breaker threshold** — 3s timeout, fallback to 503; adjust based on prod Central latency baseline (post-5d)
