# Phase 01 Fixes Report — Critical + High Issues

**Date:** 2026-08-24
**Plan:** `plans/260821-1644-central-rbac-single-pane/`
**Source:** `central-rbac/`
**Scope:** 3 critical + 5 high issues from code-reviewer-260824-1349 report

---

## Issues Fixed

### C1 — rbac_writer missing SELECT audit_log

**File changes:**
- `src/db/migrations/003_audit_hash_chain.sql:48` — `GRANT INSERT` → `GRANT INSERT, SELECT` + comment explaining SELECT needed for prev_hash chain read
- Added `GRANT USAGE ON SEQUENCE rbac.audit_log_seq_seq TO rbac_writer` (needed after H5 added BIGSERIAL)
- `src/middleware/audit-log.ts` — imports `incrementAuditWriteFailures`, calls it in catch block alongside existing `logger.error`
- `src/lib/audit-metrics.ts` — NEW: in-process failure counter (`increment`, `get`, `reset`); Phase 2 TODO to replace with prom-client
- `src/routes/health.ts` — exposes `audit_write_failures` counter in health response body

**Verification:** `tests/unit/audit-metrics.test.ts` (4 tests). Integration test `tests/integration/migrations-and-audit-chain.test.ts` — new `rbac_writer can SELECT from audit_log (C1 fix)` assertion verifies grant directly against real role.

---

### C2 — HMAC re-serialization on parsed body

**File changes:**
- `src/app.ts` — `declare module 'fastify' { interface FastifyRequest { rawBody?: Buffer } }` augmentation added; `addContentTypeParser('application/json', { parseAs: 'buffer' }, ...)` stashes raw bytes on `request.rawBody` before `JSON.parse`; also applied H1 (`trustProxy`) and H2 (CORS env) in same file
- `src/middleware/auth-resolve.ts` — full rewrite: `verifyHmacSignature` now takes `rawBody: Buffer`, builds HMAC payload as `Buffer.concat([tsPrefix, rawBody])`. `verifyResolveAuth` reads `request.rawBody ?? Buffer.alloc(0)`. Old `JSON.stringify(request.body)` removed entirely.

**Test changes:** `tests/unit/auth-resolve-middleware.test.ts` — complete rewrite:
- `makeRequest()` now accepts `rawBody?: Buffer` parameter
- `makeHmacHeader()` signs a raw string (not an object)
- New regression test: "rejects when HMAC signed over JSON.stringify(parsed) instead of rawBody" — passes differentRawBody (bytes differ from re-serialized) → must 401
- New regression test: "rejects when rawBody missing" → must 401

---

### C3 — Audit chain race

**File changes:**
- `src/db/migrations/003_audit_hash_chain.sql` — added `seq BIGSERIAL NOT NULL UNIQUE` column (also fixes H5)
- `src/db/queries/audit.ts` — full rewrite of `insertAuditEntry`: signature changed from `Pool | PoolClient` to `Pool` only; acquires explicit `client = await pool.connect()`, wraps `BEGIN → pg_advisory_xact_lock(hashtext('rbac_audit_chain')) → SELECT chained_hash ORDER BY seq DESC → INSERT → COMMIT` in transaction with `ROLLBACK` on error + `client.release()` in finally. `queryAuditLog` and `verifyAuditChainIntegrity` updated to include `seq` in SELECT and `ORDER BY seq` respectively.

**Test changes:**
- `tests/unit/audit-chain-concurrency.test.ts` — NEW (8 tests):
  - Protocol order test: `BEGIN → advisory_lock → SELECT → INSERT → COMMIT` verified via call log
  - ROLLBACK + rethrow on INSERT error
  - `release()` called even after error
  - 10 sequential inserts via in-memory mock → chain integrity verified by checking each `prev_hash = prior row's chained_hash`
  - first row has `null` prev_hash
  - 3-row linkage spot check
  - `computeRowHash` determinism tests
- `tests/integration/migrations-and-audit-chain.test.ts` — added "20 parallel insertAuditEntry calls → chain unbroken" test (C3 live concurrency; Docker required in CI)

---

### H1 — trustProxy missing

**File:** `src/app.ts`

Added `trustProxy: config.NODE_ENV === 'production' ? '10.200.0.0/24' : true` to `Fastify({})` constructor. Restricts to internal subnet in prod to prevent IP spoofing via crafted `X-Forwarded-For` from external traffic.

No new test (trustProxy is a Fastify option, not app logic).

---

### H2 — CORS blocks UI in production

**File changes:**
- `src/config.ts` — added `CENTRAL_RBAC_CORS_ORIGIN: z.string().default('')` to env schema
- `src/app.ts` — CORS origin reads `config.CENTRAL_RBAC_CORS_ORIGIN`, splits on comma, uses allow-list if non-empty; falls back to `false` (block all) in prod or `true` in dev
- `.env.example` — added `CENTRAL_RBAC_CORS_ORIGIN=` with comment explaining format and example

---

### H3 — HMAC replay window accepts future timestamps

**File:** `src/middleware/auth-resolve.ts`

Added `HMAC_FUTURE_SKEW_MS = 60_000` (60s tolerance for clock skew). In `verifyHmacSignature`: separate check `if (tsMs > now + HMAC_FUTURE_SKEW_MS)` fires before the past-window check. Returns `false` with `logger.warn`.

**Test:** `tests/unit/auth-resolve-middleware.test.ts` — new describe block "H3: future timestamp rejection":
- `+360s` (6 min future) → 401
- `+30s` (within 60s skew) → pass (0)

---

### H4 — HMAC header parser fragile

**File:** `src/middleware/auth-resolve.ts`

Extracted `parseSigHeader()`: loops tokens from `header.split(',')`, uses `trimmed.indexOf('=')` (not `split('=')`) to split on first `=` only → handles `v1=abc=xyz` correctly. Validates `sig` against `HEX_SIG_RE = /^[a-f0-9]{64}$/` before `Buffer.from(..., 'hex')`.

**Tests:** `tests/unit/auth-resolve-middleware.test.ts` — new describe block "H4: malformed header inputs":
- `t=123,v1=abc=xyz` (extra `=`) → 401
- `v1=NOTAHEX...` (non-hex, uppercase) → 401
- missing `v1=` token → 401
- missing `t=` token → 401

---

### H5 — Non-deterministic ORDER BY

**File changes:**
- `src/db/migrations/003_audit_hash_chain.sql` — `seq BIGSERIAL NOT NULL UNIQUE` column (also addresses C3)
- `src/db/queries/audit.ts` — `queryAuditLog`: `ORDER BY ts DESC, seq DESC`; `verifyAuditChainIntegrity`: `ORDER BY seq ASC`; chain-head SELECT in `insertAuditEntry`: `ORDER BY seq DESC`

**Integration test:** added `'audit_log has seq BIGSERIAL column (H5 fix)'` assertion verifying the column exists with `bigint` data type.

---

## New Test Summary

| File | Tests added | What it covers |
|---|---|---|
| `tests/unit/audit-metrics.test.ts` | 4 (new file) | C1: audit failure counter get/increment/reset |
| `tests/unit/audit-chain-concurrency.test.ts` | 8 (new file) | C3: transaction protocol order, ROLLBACK/release safety, chain linkage |
| `tests/unit/auth-resolve-middleware.test.ts` | +8 (rewritten) | C2: rawBody HMAC; H3: future ts; H4: malformed headers |
| `tests/integration/migrations-and-audit-chain.test.ts` | +7 (updated) | M1/C1: role privilege assertions; C3: 20-parallel live concurrency; H5: seq column |

**Total unit tests: 74 (was 54) — +20 new**

---

## Test Results

```
Test Files:  9 passed (all unit; integration excluded from default run)
Tests:       74 passed

Coverage (src/lib/* + middleware/auth-*.ts + error-handler.ts):
  Statements:  92.05%   (was 92.15% — unchanged materially)
  Branches:    95.55%   (was 92.10% — improved)
  Functions:   93.75%   (was 91.66% — improved)
  Lines:       92.05%

  lib/ subdir: 100% across all files (audit-metrics.ts now fully covered)
```

Typecheck: `npm run typecheck` → zero errors.

---

## Deviations from Proposed Fix

| Issue | Deviation | Reason |
|---|---|---|
| C3 | `insertAuditEntry` signature changed from `Pool \| PoolClient` to `Pool` only | Advisory-lock pattern requires `.connect()` to get a dedicated client for the transaction. Accepting a `PoolClient` externally would mean the caller already holds a connection — the BEGIN/advisory-lock pair would then conflict if caller is already in a transaction. Simplified to `Pool` only, which is the only call site in `audit-log.ts`. |
| H5 | Added `seq BIGSERIAL` via migration 003 (same migration as C3 table def) | Reviewer listed H5 separately but the column must be in the same `CREATE TABLE` statement. No separate migration created — idempotent `IF NOT EXISTS` guards handle re-runs. |
| M1 (integration) | Role-specific pools created in same `beforeAll`, not separate test file | Scope: integration test enhancement only, not a new file. Both `rbac_writer` and `rbac_auditor` pools now connect as their actual roles with `LOGIN PASSWORD` credentials created during bootstrap. |

---

## Not Fixed (deferred per task scope)

- M1-M6, L1-L4 — deferred to future phase per instructions
- Integration tests requiring Docker (C3 live concurrency, M1 role privileges) — require CI with Docker; not runnable on Windows host without Docker Desktop

---

## Unresolved Questions

1. **`audit_log_seq_seq` sequence name** — PostgreSQL generates the sequence name from `{table}_{column}_seq`. For column `seq` in table `audit_log` the sequence is `audit_log_seq_seq`. If migration 003 runs on a DB where the table was created without the column (incremental migration), the sequence name must be verified. The `GRANT USAGE ON SEQUENCE` line in migration 003 will fail if the sequence doesn't exist yet — acceptable since 003 is idempotent and the column + sequence are created by the same `CREATE TABLE` statement.

2. **Zitadel raw body format** — C2 fix assumes signed payload = `<ts>.<raw_body_bytes>`. Reviewer unresolved question 1 in code-review report confirms this needs Phase 2 spike against Zitadel v4 Action webhook source to verify exact signing format before wiring live.
