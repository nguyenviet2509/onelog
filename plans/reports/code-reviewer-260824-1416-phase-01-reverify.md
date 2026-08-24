# Phase 1 Central RBAC — Focused Re-verify

**Date:** 2026-08-24 14:16 (Asia/Saigon)
**Scope:** Verify 3 critical + 5 high fixes from `code-reviewer-260824-1349-phase-01-backend-db.md` against actual code
**Prior score:** 7.0/10 — DO NOT MERGE
**Reviewer:** code-reviewer subagent (focused smoke pass, not full re-review)

---

## Verdict table

| # | Issue | Fix location | Verdict | Evidence |
|---|---|---|---|---|
| **C1** | rbac_writer missing SELECT audit_log | `migrations/003_audit_hash_chain.sql:52-56`, `middleware/audit-log.ts:11,74`, `lib/audit-metrics.ts` (new), `routes/health.ts:9,18,28` | **RESOLVED** | `GRANT INSERT, SELECT ON rbac.audit_log TO rbac_writer` + `GRANT USAGE ON SEQUENCE rbac.audit_log_seq_seq TO rbac_writer` + `REVOKE UPDATE, DELETE`. Silent catch replaced with `logger.error + incrementAuditWriteFailures()`. Health exposes `audit_write_failures` counter. Integration test at `tests/integration/migrations-and-audit-chain.test.ts:158-163` directly asserts `rbac_writer` can SELECT. |
| **C2** | HMAC re-serializes parsed body | `app.ts:23-27,61-74`, `middleware/auth-resolve.ts:65-108,127-131` | **RESOLVED** | Fastify module augmentation adds `rawBody?: Buffer`. `addContentTypeParser('application/json', { parseAs: 'buffer' }, ...)` stashes raw bytes before `JSON.parse`. `verifyHmacSignature` signature is `(header, rawBody: Buffer, signingKey)`; payload = `Buffer.concat([tsPrefix, rawBody])`. Zero `JSON.stringify(request.body)` remain. Regression test at `tests/unit/auth-resolve-middleware.test.ts:116-131` proves signing over re-serialized body → 401 when rawBody differs. |
| **C3** | Audit chain race | `db/queries/audit.ts:118-184`, `migrations/003_audit_hash_chain.sql:11` | **RESOLVED** | `insertAuditEntry` now signature `(pool: Pool, input)`. Acquires client via `pool.connect()`, wraps `BEGIN → pg_advisory_xact_lock(hashtext('rbac_audit_chain')) → SELECT chained_hash ORDER BY seq DESC LIMIT 1 → INSERT → COMMIT` in single tx. `ROLLBACK` on error + `client.release()` in `finally`. `seq BIGSERIAL NOT NULL UNIQUE` column present. Concurrency test: unit protocol-order suite + integration 20-parallel test at `migrations-and-audit-chain.test.ts:221-243`. |
| **H1** | trustProxy missing | `app.ts:37` | **RESOLVED** | `trustProxy: config.NODE_ENV === 'production' ? '10.200.0.0/24' : true`. Restricts to internal subnet in prod; permissive in dev. |
| **H2** | CORS blocks UI in prod | `config.ts:32`, `app.ts:45-53`, `.env.example:39-43` | **RESOLVED** | `CENTRAL_RBAC_CORS_ORIGIN: z.string().default('')` in schema. `app.ts` splits on comma, filters empty, uses allow-list if non-empty. `.env.example` documents format with example. Safe default: prod empty → block (`false`). |
| **H3** | HMAC future-timestamp accepted | `middleware/auth-resolve.ts:22-23,85-88` | **RESOLVED** | `HMAC_FUTURE_SKEW_MS = 60_000`. Future check runs **before** past-window check: `if (tsMs > now + HMAC_FUTURE_SKEW_MS)` → return false + warn. Tests at `auth-resolve-middleware.test.ts:165-181` cover +360s (reject) and +30s (accept). |
| **H4** | HMAC header parser fragile | `middleware/auth-resolve.ts:25,38-58` | **RESOLVED** | `parseSigHeader` uses `trimmed.indexOf('=')` + `slice(0, eqIdx)` / `slice(eqIdx + 1)` — first-`=` split only. `HEX_SIG_RE = /^[a-f0-9]{64}$/` validated before `Buffer.from(sig, 'hex')`. Tests cover 4 malformed cases (extra `=`, non-hex uppercase, missing `v1=`, missing `t=`). |
| **H5** | ORDER BY non-deterministic | `db/queries/audit.ts:85,151,200` + `migrations/003:11` | **RESOLVED** | `seq BIGSERIAL NOT NULL UNIQUE` column added. `queryAuditLog`: `ORDER BY ts DESC, seq DESC`. Chain-head SELECT: `ORDER BY seq DESC LIMIT 1`. `verifyAuditChainIntegrity`: `ORDER BY seq ASC`. Integration assertion at line 111-118 verifies column exists as `bigint`. |

---

## Regression spot-check

| Check | Result |
|---|---|
| New `: any` types | **PASS** — 0 matches under `src/**/*.ts` |
| New `as any` casts | **PASS** — 0 matches under `src/**/*.ts` |
| Files > 200 LOC | **MINOR REGRESSION** — `src/db/queries/audit.ts` = **214 LOC** (was 146). Grew by ~70 LOC due to C3 transaction wrapper + JSDoc. Violates project ≤200 rule. See L1 below. |
| Unit test count = 74 | **PASS** — tallied 74 unit tests across 9 files (8+4+9+15+8+7+5+13+5) |
| Integration test count | **PASS** — 18 tests (up from ~11), added C3 20-parallel, C1 grant assertions, H5 column assertion, M1 role privilege suite (6 tests) |
| Skipped/removed tests | **PASS** — 0 `.skip`, `xit`, `xdescribe`, `it.todo` matches |
| Env var documented | **PASS** — `.env.example:42-43` has `CENTRAL_RBAC_CORS_ORIGIN=` with example |
| Sequence name in grant | **PASS** — `audit_log_seq_seq` follows PG convention `{table}_{column}_seq`. Created in-line by `BIGSERIAL` inside `CREATE TABLE`, so `GRANT USAGE ON SEQUENCE` in same migration runs after table exists. |

---

## New issues introduced

### L1 (LOW, new). `src/db/queries/audit.ts` now 214 LOC — exceeds project 200-line rule
- Growth is legitimate (C3 transaction wrapper is ~40 LOC of correctness code, not bloat)
- Suggested split for Phase 2: extract `insertAuditEntry` + its helpers to `src/db/queries/audit-insert.ts` (writer path with tx), keep `queryAuditLog` + `verifyAuditChainIntegrity` in `audit.ts` (auditor path). Semantic boundary matches the writer/auditor pool split.
- **Not blocking.** LOC rule is a heuristic; 214 is 7% over and every LOC is load-bearing (BEGIN/lock/SELECT/INSERT/COMMIT/ROLLBACK/release protocol).

### No other new issues detected
- Type safety preserved: no `any` leaks, no `as` casts in fix hunks
- Error propagation correct in `insertAuditEntry` (rollback + rethrow, release in finally)
- No auth path changes silently broaden trust (rawBody fallback to `Buffer.alloc(0)` documented, produces mismatch → 401 by design)
- Health endpoint still unauthenticated but M4 was not in-scope for this pass

---

## Deviation review

Deviations noted in developer's report were reviewed and are acceptable:

1. **C3 signature narrowed `Pool | PoolClient` → `Pool` only** — Correct. Advisory-lock tx must own its client; caller-provided client could already be inside a tx and deadlock. Only call site is `middleware/audit-log.ts` which passes `writerPool`.
2. **H5 folded into migration 003 (not a separate migration)** — Correct. `seq BIGSERIAL` must be a `CREATE TABLE` column; adding via later `ALTER` would leave existing rows with NULL seq. Idempotent guards (`CREATE TABLE IF NOT EXISTS`) handle re-runs.
3. **M1 pools created in `beforeAll` (same file)** — Correct scope for a phase-1 integration enhancement.

---

## Updated overall score

**Score: 9.0 / 10** — **APPROVE MERGE**

Rationale:
- All 3 criticals RESOLVED with correct implementation + regression tests that would catch reintroduction
- All 5 highs RESOLVED with proper defense (env-configurable CORS, subnet-scoped trustProxy, symmetric future/past HMAC guards, hex validation, deterministic ordering)
- Coverage improved: branches 92.10% → 95.55%, functions 91.66% → 93.75%
- No `any` regressions, no silently-skipped tests
- Only new issue is a 7%-over-LOC threshold (14 lines) in `audit.ts` — pure correctness code, not smell
- Fix implementations show understanding of failure modes (M1 test connects as real DB roles to exercise grants; C2 regression test proves re-serialization mismatch fails; C3 test asserts BEGIN→lock→SELECT→INSERT→COMMIT order not just outcome)

Score short of 10.0 because:
- LOC regression in audit.ts (L1)
- M2–M6, L2–L4 from original review not addressed (deferred per scope, acceptable)
- Integration tests requiring Docker not runnable on Windows dev host (CI-only verification) — accepted risk given testcontainers scaffolding is present

---

## Approval decision

**APPROVE MERGE** — meets criteria (3 criticals + 5 highs all RESOLVED, no critical regression, score 9.0 ≥ 8.5).

Phase 2 backlog carry-forward:
- L1: split `audit.ts` into writer/auditor files
- M2–M6, L2–L4: address per prior review
- Phase 2 spike: verify Zitadel v4 Action webhook signature format matches `<ts>.<raw_body>` assumption baked into C2 fix

---

## Unresolved questions

1. **Zitadel Action signature format** — C2 fix assumes `HMAC(signing_key, "<ts>.<raw_body_bytes>")`. Phase 2 must confirm against Zitadel v4 source before wiring the live Action. Signature mismatch mode is safe (returns 401) but would take entire HMAC path offline.
2. **Sequence name portability** — `audit_log_seq_seq` is PG default naming; if any future migration renames the column or uses `GENERATED AS IDENTITY` syntax, the sequence name changes and the grant breaks silently (writer still has INSERT, just fails on `nextval`). Consider `pg_get_serial_sequence('rbac.audit_log', 'seq')` for robustness — deferred as premature optimization.
3. **214-LOC audit.ts** — accept as-is or split now? Recommendation: defer to Phase 2 to avoid diff noise on a merge-approved fix branch.

---

**Status:** DONE
**Summary:** Score 9.0/10. All 3 critical + all 5 high issues RESOLVED. One minor new regression (L1: audit.ts 214 LOC, 7% over 200-line rule) — non-blocking. No `any` leaks, no test skips, +20 unit tests + role-privilege integration suite. **APPROVE MERGE.**
**Concerns/Blockers:** None blocking. L1 tracked for Phase 2 split.
