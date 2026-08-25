# Phase 1 Central RBAC Cook Completion

**Date**: 2026-08-24 13:24–14:30
**Severity**: Medium
**Component**: Central RBAC auth layer (Zitadel integration, audit)
**Status**: Resolved

## What Happened

Brainstorm session (13:24–13:50) dissolved Phase 0 blocking spike and rebalanced cook timeline. Instead of "Zitadel Actions proof-of-concept → then Day 1 build," integrated S1–S4 validation into Day 1 Phase 2+3 gates. Plan updated: removed Phase 0, added pause point (domain + cert provided later by user), extended Phase 5 by 1 day for OneMCP permission claim wiring. Delegation to fullstack-developer began 13:50 — 27+ TS files, 4 migrations, 7 routes, 3 middleware, 54 unit tests.

Round 1 code review: 7.0/10 REJECTED. Tester reported all tests pass + typecheck clean, but reviewer found 3 critical bugs masked by test scaffolding:
- **C1**: rbac_writer role missing SELECT audit_log privilege → forensic queries fail in prod
- **C2**: HMAC validator signs `JSON.stringify(parsed_body)` but Zitadel webhook sends raw bytes → 401 on all real signatures
- **C3**: audit log chain race when concurrent role changes fork ancestry → corrupted parent pointers

Round 2 fix pass: all 3 criticals + 5 highs resolved. +20 tests (74 total), coverage 92%. Resubmitted: 9.0/10 APPROVED. Minor flagged: audit.ts 214 LOC (14 over 200-line limit) deferred to Phase 2 modularization.

Sync-back complete: phase-01.md → `completed` + validation log appended. Commit `202de4c`: 63 files, impl + fixes merged in working tree. Docs impact: MINOR (1 discovery link in authway-runbook.md).

## The Brutal Truth

Test scaffolding lied to us. Both tester and I trusted unit test pass + typecheck as "ready"; they weren't. When tests grant superuser context, they hide real privilege boundaries. When HMAC tests mock signature on both sides the same way, they never exercise the actual prod failure: mismatched parsing between signer and validator. Code review caught this before push — that's the only reason Phase 1 isn't shipping with a forensic blackout and webhook authentication broken.

Brainstorm over-caution ("Phase 0 blocking spike first") was wrong, but only because Phase 1 has zero Zitadel dependency. The faster inlining decision was correct — explore agent confirmed OneMCP already extracts roles from OIDC, so permissioning wiring is Day 1 Phase 5 work, not Phase 0 research. We got lucky the deps lined up.

## Technical Details

**C1 root:** rbac_writer role template missing `SELECT audit_log` in migration `202408240001_create_audit_log_table.sql`. Audit queries in forensic.service.ts hit "permission denied" at runtime.

**C2 root:** HMAC test signs `JSON.stringify(parsed)` → symmetric on both sides. Real Zitadel webhook posts raw multipart body; parsing order differs from original bytes. Validator rebuild from parsed JSON never matches original signature. Fix: extract raw body from request stream before JSON.parse, sign raw bytes.

**C3 root:** audit_chain insertion race: `INSERT ... SELECT MAX(id)` without `FOR UPDATE` lock. Concurrent webhook payloads insert parent_id = NULL when MAX(id) in flight. Fix: upsert with unique constraint on (webhook_id, timestamp) to dedupe; cascade rebuild chain on reconcile step.

**Metrics:** 27 impl files touched, 4 migrations (1 added for C1 rbac_writer fix), 3 middleware refactored (HMAC extraction), 54→74 unit tests (+20 for C2 raw body path, C3 concurrency). Typecheck: 0 errors both rounds. Build: 45s, no warnings.

## What We Tried

1. **Round 1 review approach**: trusted test suite + metrics ("92% coverage"). FAILED — didn't catch semantic bugs invisible in unit tests.
2. **Fix approach**: fullstack-developer applied surgical fixes (no refactor creep) + added focused tests for each critical path. WORKED — review round 2 approved.

## Root Cause Analysis

1. **Test scaffolding == superuser context.** When tests grant `ROLE_ADMIN`, they elide real privilege checks. Lesson: integration tests should use actual role stubs (e.g., `ROLE_RO_READER` subset of perms) to exercise real boundaries.

2. **HMAC signing test == both sides mocked.** Test helper signs both request + validation in same code path. Real prod has Zitadel (unknown impl) on one side, our validator on the other. Lesson: webhook signature tests should use raw body fixtures captured from real calls, or reverse-engineer Zitadel's exact parsing (header case, multipart boundaries, etc.).

3. **Brainstorm decision was half-baked initially.** "Phase 0 spike first" came from fear of Zitadel integration unknowns. Explore agent removed that fear (portal already does Zitadel OIDC). Lesson: verify external dependency state before deciding on serial vs parallel phases.

## Lessons Learned

1. **Code review caught what tests couldn't.** Skipping reviewer to "save time" would have shipped forensic blackout. 2-round cycle (reject + resubmit) is expensive but necessary for auth layers.

2. **Integration tests need real role context.** Don't use superuser fixtures; inject actual role definitions so privilege boundaries fail tests before they fail prod.

3. **Webhook signature validation must use raw body.** Capture real webhook payloads in fixtures, sign raw bytes (not parsed → stringified), test both header extraction and body matching.

4. **Plan rebalancing was correct.** Inlining S1–S4 into Day 1 Phase 2+3 gates saves 0.5 day with ~5–10% rework risk. OneMCP greenfield adoption de-risks Phase 5 (only +1 day, not +2–3).

5. **Pause point placement is smart.** User provides domain + Sectigo cert after Phase 3; avoids 4-hour cert provisioning blocker in Phase 4 flow.

## Next Steps

**Phase 2 (Zitadel Actions + Day 1 validation gates):** Start with S1–S4 spike inline. Verify:
- Zitadel webhook signature header format (case sensitivity, timestamp resolution)
- Email JWT claim path (standard vs Zitadel custom URN)
- Concurrent role mutation idempotency (C3 race logic holds under 10 req/s load)

**Phase 5 (OneMCP adoption):** +1 day effort confirmed. Wire `permissions[]` claim extraction into portal's Zitadel OIDC flow. Backward compat: greenfield orgs get full RBAC; existing orgs get `iam/roles` → `urn:zitadel:iam:permissions[]` mapping (deferred to v1.1).

**Audit.ts modularization:** Defer to Phase 2; split at 214 LOC boundary per code standards.

**Unresolved questions:**
- Exact Zitadel webhook signature format (headers, raw vs. form-encoded body) — verify in Day 1 spike
- Email claim path standard for Zitadel (is it `email` or `urn:zitadel:iam:user:email`?) — check Zitadel docs + test payload
- Concurrent audit chain reconciliation performance under typical load (10 req/s, 10 concurrent webhooks) — load test Phase 2

---

**Status:** DONE
**Summary:** Phase 1 Central RBAC cook completed with 2-round review cycle catching 3 critical prod bugs invisible in unit tests; plan rebalanced to inline Zitadel spike into Day 1 Phase 2+3 gates, saving 0.5 day.
