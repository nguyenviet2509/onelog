# Phase 2 Day 1 Spike Findings — Doc Sync Report

**Date:** 2026-08-24  
**Agent:** docs-manager  
**Task:** Update Phase 2 spec + gate reports with human OIDC login confirmation + cleanup checklist

---

## Summary

Day 1 spike completed 2026-08-24 with definitive findings from both machine user (S4 initial) and human OIDC user (S4 retry) tests. Critical discovery: `user.grants` field **completely absent** from Zitadel v4.16.1 webhook payload for **both user types**. Plan assumption void. Updated phase-02 spec and gate reports to reflect findings + cleanup procedures.

---

## Files Modified

### 1. `plans/260821-1644-central-rbac-single-pane/phase-02-zitadel-action.md`

**Changes:**
- Replaced "Key insights" section with definitive findings from Day 1 spike
- Marked `user.grants` assumption as VOID with explicit evidence link
- Updated Day 1 gate status to "✅ COMPLETED 2026-08-24"
- Added new section "Day 1 spike findings (2026-08-24)" with F1-F4 structured findings:
  - **F1**: `user.grants` absent — require ListUserGrants API call or cache
  - **F2**: HMAC algorithm unconfirmed — brute-force candidates listed
  - **F3**: Fail-open policy confirmed — `rbac_degraded` + separate fail-close Target for admins
  - **F4**: Payload structure vs plan — `user.human`/`user.machine`, no `amr` in payload

**Impact:** Phase 2 implementation must now:
1. Call Zitadel `ListUserGrants()` API for each token (cold path) OR read from Central RBAC cache (Phase 3)
2. Implement HMAC verification with fallback to IP allowlist until algorithm confirmed
3. Always emit `rbac_degraded:true` on resolve failure
4. Use `interruptOnError:true` Target config for admin roles (separate from normal target)

### 2. `plans/reports/gate-260824-s4-payload-shape.md`

**Changes:**
- Added section "Human OIDC login verification (2026-08-24 16:25 - retry with JWT AccessTokenType)"
- Pasted actual human user webhook payload (spike-user@spike-test.local)
- Pasted actual JWT access_token post-append_claims
- Compared human vs machine user payload (both missing `grants`)
- Updated verdict from "CONDITIONAL PASS" → "CONDITIONAL PASS → ACTIONABLE FINDINGS"
- Explicit: "`user.grants` is **NOT provided by Zitadel v4.16.1 for either user type**"

**Evidence captured:**
- Human user ID: `387657093185798148`
- OIDC client type: Web (JWT AccessTokenType required)
- Grants count: 0 (SAME as machine user, confirms absence)
- No `amr` field in payload (SAME as machine user)

### 3. `plans/reports/gate-260824-s3-fail-mode.md`

**Changes:**
- Simplified cleanup checklist (moved inline SSH commands into code block)
- Reorganized: "On authway-vps", "In Zitadel Console", "On local"
- Added emphasis on DenyList restoration + verification
- Option to keep spike-test org for Phase 3 spike (S1 idempotency testing)
- Clarified local spike code cleanup (gitignored, no commit needed)

---

## Findings Applied to Phase 2

| Finding | Impact | Phase 2 Action |
|---------|--------|----------------|
| **F1: No `user.grants` in payload** | Plan assumed direct grants access ❌ | Call `mgmtClient.listUserGrants(userId, orgId)` + Redis cache TTL 5-15min OR consume Phase 3 cache |
| **F2: HMAC algo unconfirmed** | Verification might fail in prod ⚠️ | Day 2 brute-force test candidates listed; fallback to IP allowlist + strict source check (Docker network) |
| **F3: Fail-open default** | Silent token issuance on webhook failure ❌ | **MUST** return `rbac_degraded:true` on error; apps MUST reject degraded tokens. Separate `interruptOnError:true` Target for admin roles |
| **F4: Payload `user.human`/`user.machine` not flat** | Phase 2 parser needs to handle sub-objects ✓ | No `amr` at top level; check payload structure in code |

---

## Latency Budget Adjustment

**Old assumption (F1 void):**
- p99 resolve cache hit: <100ms
- p99 resolve cache miss: <500ms (CTE only)

**New reality (F1 + fallback API):**
- p99 resolve cache hit: <100ms ✓ unchanged
- p99 resolve cache miss cold: <800ms (includes ListUserGrants API ~50-200ms + CTE + Redis write)
  - Mitigation: warm cache on startup for top-100 roles; user-grants cache separate with TTL
  - Singleflight prevents cache stampede even with new API call

---

## Cleanup Checklist (Ready to Execute)

Checklist now in `gate-260824-s3-fail-mode.md`:

1. **On authway-vps:** Remove DenyList override, restart Zitadel, stop spike-webhook
2. **In Zitadel Console:** Delete spike-target, execution, optionally spike-test org
3. **On local:** Remove `central-rbac/spike/` (gitignored, no commit needed)

Target execution: **After Phase 2 Day 2-3 implementation + integration tests** (not yet).

---

## Unresolved Questions

1. **F2 — HMAC algorithm:** Which of the 5 candidates is correct? Need Zitadel v4.16.1 source or working reverse-engineering during Day 2 implementation.
2. **F2 fallback:** If HMAC cannot be verified, is IP allowlist acceptable for initial deploy? (Recommended: yes, with plan to migrate to HMAC once algo confirmed.)
3. **Phase 3 cache coverage:** Will Central RBAC drift-sync populate enough users' grants to avoid cold ListUserGrants calls? Or does Phase 2 need to pre-warm top-N users?

---

## Status

**Status:** DONE  
**Summary:** Day 1 spike findings (human OIDC confirmation + F1-F4) applied to phase-02 spec and gate reports. Phase 2 implementation now reflects definitive payload structure (no `user.grants`) and fail-open policy. Cleanup checklist ready. Phase 2 can proceed with ListUserGrants API + cache strategy, HMAC verification investigation, and `rbac_degraded` fallback claim.
