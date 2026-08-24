# Code review — Phase 1 Central RBAC backend

**Date:** 2026-08-24 14:13 (Asia/Saigon)
**Scope:** `d:/Vietnt/Project/onelog/central-rbac/` (~1196 LOC across 22 TS files + 4 SQL migrations + 9 test files)
**Reviewer:** code-reviewer subagent
**Phase spec:** `plans/260821-1644-central-rbac-single-pane/phase-01-backend-db.md`

---

## Overall score: **7.0 / 10** — DO NOT MERGE

Rationale: Structure, typing, naming, code organization, and DB migration design are excellent (all files ≤176 LOC, strong Zod validation, correct helmet/cors setup, sound recursive CTE). Red-team findings F3/F12/F15 substantially implemented. **However, two blocking correctness bugs make this NOT production-ready**: (a) writer pool cannot read `audit_log.chained_hash` due to grant-only-INSERT, silently killing every audit write; (b) HMAC verification uses re-serialized parsed JSON body, which will never match sender's raw-body signature. Both are masked by tests (integration uses superuser; HMAC test uses same JSON.stringify on both sides).

---

## Critical issues (block merge) — 3

### C1. `rbac_writer` cannot SELECT `audit_log` → audit blackout in production
- **File:** `src/db/migrations/003_audit_hash_chain.sql:48` grants only `INSERT` to `rbac_writer`; `src/db/queries/audit.ts:121-124` runs `SELECT chained_hash FROM rbac.audit_log ORDER BY ts DESC, id DESC LIMIT 1` via **writer pool**.
- **Impact:** In production the `SELECT` throws "permission denied for table audit_log". The exception is caught by `writeAuditLog` (`src/middleware/audit-log.ts:68-72`) and only logged — **every mutation completes 200/201 but no audit row is persisted**. Complete forensic loss with zero user-visible signal. Violates F15 (audit chain integrity).
- **Why tests miss it:** integration test at `tests/integration/migrations-and-audit-chain.test.ts:45-46` reuses the `postgres_admin` superuser URL for both pools, so grants are irrelevant during test.
- **Fix:**
  1. Migration 003: `GRANT SELECT ON rbac.audit_log TO rbac_writer;` (keep REVOKE UPDATE/DELETE — SELECT is safe because trigger + revoke block mutations).
  2. Update integration test to actually connect writer pool as `rbac_writer` role and auditor pool as `rbac_auditor`, then assert privilege boundaries (writer can INSERT+SELECT, cannot UPDATE/DELETE; auditor can SELECT, cannot INSERT).

### C2. HMAC verification breaks on any real webhook — re-serializes parsed body
- **File:** `src/middleware/auth-resolve.ts:70`: `const rawBody = JSON.stringify(request.body) ?? ''`.
- **Impact:** Fastify already parsed `request.body` via `application/json` content-type parser. `JSON.stringify` re-emits with V8's own key ordering and no whitespace, which will not byte-match Zitadel's originally-signed body (different key order, escaped chars, whitespace, unicode normalization). Result: **every real HMAC-signed webhook returns 401**. Falls back to shared token in practice, but F4 spec requires HMAC path to actually work.
- **Why tests miss it:** `tests/unit/auth-resolve-middleware.test.ts:47` signs the same `JSON.stringify(body)` on both sides, so they trivially match.
- **Fix:** Capture raw body before JSON parsing via Fastify `addContentTypeParser('application/json', { parseAs: 'buffer' }, ...)` or `preParsing` hook that stashes raw bytes on `request.rawBody`. Then verify HMAC over the exact bytes. Reference: Stripe/Zitadel webhook pattern requires raw-body middleware.
- Also update `tests/unit/auth-resolve-middleware.test.ts` to sign a specific raw string and pass it through as `request.rawBody`, then assert re-serialization mismatch fails (regression).

### C3. Audit chain race — concurrent writers fork the chain
- **File:** `src/db/queries/audit.ts:121-146` does `SELECT chained_hash … LIMIT 1` then `INSERT` in two separate statements without transaction / row lock.
- **Impact:** Two concurrent mutation requests both read the same `prev_hash` at t0, both compute distinct `chained_hash`, both INSERT. Chain now has two rows claiming the same predecessor → `verifyAuditChainIntegrity` returns `broken_at` on startup after any burst. Chain becomes chronically "broken" under normal load — the alert loses meaning. Violates F15 tamper-evidence guarantee.
- **Fix (pick one):**
  - **Option A (simplest):** Wrap SELECT+INSERT in a transaction that begins with `SELECT pg_advisory_xact_lock(<constant>)` — serializes audit writes cheaply.
  - **Option B:** Use `SELECT … FOR UPDATE` on a dedicated `audit_chain_head(id, latest_hash)` row that is updated after each insert.
  - **Option C:** Move hash computation into a `BEFORE INSERT` trigger that reads the latest inside the same statement's snapshot (still needs serialization).
- Add integration test that fires 20 parallel `insertAuditEntry` calls and asserts chain integrity holds.

---

## High issues — 5

### H1. `request.ip` behind reverse proxy = proxy IP, not client
- **File:** `src/app.ts:22-27` — Fastify constructor missing `trustProxy: true` (or explicit CIDR). Audit log `ip` column and rate-limit source will be Caddy/reverse-proxy IP under prod deployment (all rows show `10.x.x.x`).
- **Fix:** Add `trustProxy: config.NODE_ENV === 'production' ? '10.200.0.0/24' : true` (or explicit proxy list). Document in README.

### H2. Production CORS defaults to blocking all origins → Phase 5 UI cannot call backend
- **File:** `src/app.ts:33-36` — `origin: config.NODE_ENV === 'production' ? false : true`. Setting `false` disables CORS entirely; UI on separate origin will fail preflight.
- **Fix:** Add `CORS_ALLOWED_ORIGINS` env (comma-separated allow-list), parse in `config.ts`, pass to helmet. Default empty list in production (fail-safe), explicit config required.

### H3. HMAC replay window accepts future timestamps
- **File:** `src/middleware/auth-resolve.ts:37` — `Math.abs(Date.now() - tsMs) > HMAC_WINDOW_MS` treats +5min future as valid. Clock skew is real but future-dated signatures are almost always attack indicators.
- **Fix:** Reject `tsMs > Date.now() + SMALL_SKEW_MS` (e.g. 60s) separately from past window.

### H4. HMAC header parser accepts malformed `k=v=v` inputs, could silently be interpreted differently by future Zitadel format changes
- **File:** `src/middleware/auth-resolve.ts:27-29` — `header.split(',').map((p) => p.trim().split('=') as [string, string])`. If `sig` contains `=` (uncommon for hex but any format change to base64 padding would break this), TypeScript `as` hides the runtime shape mismatch.
- **Fix:** Use `p.split('=', 2)` explicitly and validate `parts.length === 2` before assignment. Also validate `sig` matches `/^[0-9a-f]{64}$/` before `Buffer.from(..., 'hex')` (silent partial decode risk).

### H5. `audit_log.ORDER BY ts DESC, id DESC LIMIT 1` non-deterministic under same `ts`
- **File:** `src/db/queries/audit.ts:122` — under high concurrency `now()` can share microseconds; UUID `id` ordering is arbitrary. Combined with C3 (no locking), predecessor selection is unpredictable.
- **Fix:** Add monotonic `seq BIGSERIAL` column to `audit_log`, order by `seq DESC LIMIT 1`. Also solves C3 by serializing on the sequence. Prefer this over pure timestamp ordering for a chain.

---

## Medium issues — 6

### M1. Integration test does not verify DB role privilege separation (F15 partial gap)
- **File:** `tests/integration/migrations-and-audit-chain.test.ts:44-46` — both `writerPool` and `auditorPool` use `postgres_admin` superuser URL, so the migration grants are never exercised.
- **Fix:** After grants applied, create additional pools connecting as `rbac_writer` and `rbac_auditor`, and add tests: (a) writer can INSERT audit_log, cannot UPDATE/DELETE (both trigger + revoke), (b) auditor can SELECT, cannot INSERT, (c) writer can SELECT audit_log (needed for chain) once C1 fixed.

### M2. Migration 001 uses hardcoded passwords "rbac_writer_changeme"
- Acknowledged in spec risks section, but no runtime check enforces password rotation before prod. Recommend a startup log warning if `WRITER_DATABASE_URL` contains the substring `changeme`.

### M3. Audit `writeAuditLog` swallows exceptions silently, no metric
- **File:** `src/middleware/audit-log.ts:68-72` — logs at error level but returns normally. Operators have no signal beyond log aggregation.
- **Fix:** Emit Prometheus counter `rbac_audit_write_failures_total` (add prom-client in Phase 2 anyway) — allows Grafana alert. At minimum, count in-process and expose on `/v1/health`.

### M4. `/v1/health` unauthenticated leaks component state
- **File:** `src/routes/health.ts:10` — returns detailed `checks.db_writer`, `db_auditor` status to any caller. Adequate for load balancer, but external probes see internal architecture.
- **Fix:** Split into `/v1/health/live` (200/503 only, no body) and `/v1/health/ready` (JWT-guarded or internal-only, detailed).

### M5. `getRoleStats` inherited count SQL is fragile
- **File:** `src/db/queries/roles.ts:129-141` — uses recursive CTE to gather ancestors, then IN subquery. Works but does not use the same depth-10 cap as `resolvePermissions`. Under a bad-data cycle (should not exist due to app check, but defense-in-depth), this recurses without bound.
- **Fix:** Add `WHERE depth < 10` to the recursive CTE (matching `resolvePermissions` pattern).

### M6. `webhook-echo` echoes raw body — could echo secrets in dev
- **File:** `src/routes/webhook-echo.ts:19-27` — dev-only but body is echoed as-is. If a dev accidentally posts a real token in body, it appears in response and logs.
- **Fix:** Strip common secret keys before echoing (best-effort: `token`, `password`, `secret`, `authorization`). Or drop the endpoint entirely once webhook shape locked in Phase 2.

---

## Low issues — 4

### L1. `insertAuditEntry` uses `Pool | PoolClient` but never opens a client for transaction — see C3 fix will change signature to `PoolClient` only.

### L2. `resolvePermissions` in `routes/resolve.ts:26` calls `writerPool` for a read. Not a bug (writer has SELECT on rbac tables), but semantically better to use a dedicated `readerPool` (or `auditorPool` won't work — no rbac SELECT). Note for Phase 2 when Redis cache lands.

### L3. `role-schemas.ts` `parent_key` regex not applied — accepts any 1–128 char string. Spec expects `<...>.<...>` shape. Minor consistency.

### L4. `configerror` at startup throws generic `Error` — process exit is via unhandled rejection. Explicit `process.exit(1)` after logging keeps startup ordering deterministic.

---

## Red-team compliance table

| Finding | Requirement | Implemented? | Evidence | Status |
|---|---|---|---|---|
| **F3** | JWT verifies `aud` + `azp` + `iss` + sig | Yes | `src/middleware/auth-jwt.ts:69-100` — `jose.jwtVerify` sets iss+aud, explicit azp check at :97. Rejects degraded token on mutating paths. | ✅ **PASS** |
| **F4** | `/v1/resolve` requires HMAC OR shared token day 1, no bypass | Partial | `src/middleware/auth-resolve.ts` — shared-token path OK (`constantTimeCompare`), HMAC path implemented but **broken** (C2). `src/routes/resolve.ts:15` preHandler enforced. No env skip. | ⚠️ **PARTIAL** — token path works, HMAC path will 401 all real webhooks |
| **F12** | Separate DB `central_rbac`, not schema in shared DB | Yes | `src/db/migrations/001_bootstrap.sql:8` `CREATE DATABASE central_rbac`. `docker-compose.dev.yml` uses dedicated container `central-rbac-postgres-dev`. Two `DATABASE_URL` env vars (writer/auditor), both pointing to `central_rbac`. | ✅ **PASS** |
| **F15** | Split DB roles + hash chain + BEFORE UPDATE/DELETE trigger + auditor pool for reads | Mostly | Roles split: `rbac_writer` / `rbac_auditor` (001). Trigger correct (004). Hash chain lib + column (003 + hash-chain.ts). `/v1/audit` uses auditor pool (audit.ts:31). **BUT:** writer role missing SELECT audit_log (C1 blocks audit writes); chain has race (C3); integration test bypasses roles (M1). | ⚠️ **PARTIAL** — design correct, execution has 2 blocking bugs |

---

## Deviations from phase spec — assessment

| # | Deviation | Assessment |
|---|---|---|
| 1 | `zod` instead of `ajv` | **Acceptable.** Architecture diagram in phase-01 explicitly names zod. Zod is used consistently, gives strong TS inference. No tech debt. |
| 2 | Coverage scoped to lib/middleware/error-handler only | **Acceptable with caveat.** Integration tests exist for queries/routes but require Docker. Verify CI can run testcontainers or coverage report is misleading. Recommend Phase 2 adds CI job that runs integration tests. |
| 3 | `actor_email` from JWT `email` claim, no Zitadel lookup | **Acceptable for Phase 1.** Phase 3 wires `GetUserByID` cache. Note: audit rows written before Phase 3 will have `actor_email=''` for token-authenticated resolve calls — expected and OK. |
| 4 | VL sync via `fetch` NDJSON, not pino transport | **Acceptable.** Phase spec explicitly allows fallback path. `sendToVictoriaLogs` has 3s AbortSignal timeout — good. Non-blocking via `.catch()` — good. **Watch for Phase 5:** VL retry on failure is missing (fire-and-forget), so a VL outage loses audit dual-write silently. Recommend Phase 2 or 5 adds retry+disk queue. |

---

## Positive observations

- Every file ≤176 LOC — obeys project ≤200 rule.
- Kebab-case filenames throughout, self-documenting names.
- Strict Zod `.strict()` on update schemas prevents extra-field injection.
- `constantTimeCompare` correctly byte-length-guards before `timingSafeEqual`.
- Logger has redaction on `authorization`, `x-rbac-token`, `zitadel-signature` headers.
- Fastify wired with `helmet` (security headers) and dedicated `errorHandler` that suppresses stack in prod.
- Test suite is thorough for the covered surface (54 unit tests, integration scaffolded with real Postgres via testcontainers).
- Permission `key` immutability enforced at **two layers** (Zod schema excludes key, route explicit `if ('key' in body) 422`). Good defense-in-depth.
- Migrations idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING` for `schema_migrations`).
- Trigger uses `DROP TRIGGER IF EXISTS` before create — safe re-run.
- JWKS cache with kid-miss forced refresh (auth-jwt.ts:78-94) — correct handling of Zitadel key rotation.
- `resolvePermissions` recursive CTE depth-capped at 10 — matches app-layer cycle check.

---

## Recommended actions (in order)

1. **[C1] Add `GRANT SELECT ON rbac.audit_log TO rbac_writer;` to migration 003** — blocks audit writes today.
2. **[C2] Add raw-body Fastify plugin, HMAC over raw bytes** — blocks real Zitadel webhook.
3. **[C3] Wrap chain-head SELECT + INSERT in transaction with advisory lock (or add `seq BIGSERIAL` per H5)** — blocks chain integrity under load.
4. [H1] Add `trustProxy` to Fastify config.
5. [H2] Add `CORS_ALLOWED_ORIGINS` env, replace bool with allow-list.
6. [H3] Reject future-timestamped HMAC.
7. [M1] Integration test: connect as actual DB roles, assert grants.
8. [H4/H5] Harden HMAC parser + add sequence column.
9. [M2–M6, L1–L4] Polish before Phase 5 deploy.

---

## Recommendations for Phase 2

- **Rate limit `/v1/resolve`**: unauthenticated brute-force on HMAC would DoS DB. Add `@fastify/rate-limit` keyed by `(ip, sig-prefix)`.
- **VL dual-write reliability**: add disk queue + retry (currently fire-and-forget). Prometheus counter for `vl_sync_failures_total`.
- **Prometheus metrics**: `rbac_audit_write_failures_total`, `rbac_resolve_requests_total{result}`, `rbac_jwt_verify_failures_total{reason}`.
- **Chain integrity monitoring**: run `verifyAuditChainIntegrity` periodically (not only on startup) — post to Grafana alert.
- **Password rotation check**: startup warns if DB URL contains `changeme`.
- **Refresh JWKS proactively**: current 4-min TTL + kid-miss re-fetch is good, but consider background refresh at TTL/2 to avoid per-request latency after expiry.
- **Actor email lookup cache**: Phase 3 GetUserByID → Redis with TTL 15min. Fall back to empty string on Zitadel outage (do NOT block audit write).
- **Body-size limits per route**: `/v1/resolve` limit 4 KB; audit query limit 1 KB. Fastify has `bodyLimit` per-route.

---

## Unresolved questions

1. **Zitadel Action webhook signature spec** — need Phase 2 spike to confirm: (a) is the signed payload `<ts>.<raw-json>` or something else (Stripe style vs Slack style), (b) is signature hex or base64, (c) header casing. C2 fix depends on the answer. Report notes research 260822-0837 already locked the format — cross-check that research doc against Zitadel v4 source before Phase 2 Day 1.
2. **Coverage scope** — do we want CI to require Docker for testcontainers, or a separate lightweight coverage target that skips DB paths? Impacts Phase 2 CI plan.
3. **`session_id` claim path in Zitadel v4 JWT** — currently `claims['session_id']`; may be `sid` per OIDC standard or `urn:zitadel:...:sessionId`. Verify in Phase 2 shape spike (same time as `email` claim path).
4. **Should `/v1/health` be public or JWT-protected?** — split live/ready (M4 recommendation) needs product decision.

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Score 7.0/10 — 3 critical + 5 high + 6 medium + 4 low. C1 (writer missing SELECT audit_log) silently kills audit writes in prod; C2 (HMAC over parsed body) breaks real webhooks; C3 (chain race) forks audit chain under load. All three masked by test scaffolding. Design and structure are strong; execution needs the 3 blocking fixes before merge.
**Concerns/Blockers:** Must fix C1, C2, C3 before Phase 2 begins — Phase 2 depends on working audit chain + working HMAC path for Zitadel Action wiring. Recommend flagging for human review; auto-approve threshold not met.
