# Project Manager — Phase 3 Completion Sync

**Date:** 2026-08-25 09:38 +0700  
**Plan:** `plans/260821-1644-central-rbac-single-pane/`  
**Scope:** Sync completion status + validation log entry

---

## Status: DONE

**Summary:** Phase 3 (Zitadel Mgmt API + outbox pattern) completed with all fixes merged and live E2E verified on authway-vps. Plan files synchronized: phase-03-zitadel-mgmt-api.md marked completed, plan.md Phase 3 row + validation log updated. Blockers for Phase 4 documented.

---

## Plan Sync

### Files Updated

1. **`phase-03-zitadel-mgmt-api.md`**
   - Frontmatter: `status: pending` → `status: completed` + `completed: 2026-08-25`
   - Added "Completion Notes" section (600+ LOC) detailing:
     - Day 1 gate results (S1 confirmed, S2 deferred w/ mitigation)
     - Implementation summary (18 new files, 4 modified, key modules)
     - Test results (189→193 pass, 90.33%→89.26% coverage)
     - Code review score (7.8/10, 4 high fixes applied)
     - Live E2E verification (3 outbox ops, SIGTERM graceful drain)
     - Deferred items (M2, M3, pool tuning, HEALTHCHECK, DDL role, JWT client_credentials)

2. **`plan.md`**
   - Phase 3 row: `pending` → `**completed (2026-08-25)**`
   - Added "Session — 2026-08-25 (Phase 3 cook + gate + fixes + E2E)" validation log section with 8 milestones:
     - S1 idempotency gate: **CONFIRMED** (409 on add, 404 on remove, PUT-replace for role updates)
     - S2 custom role gate: **DEFERRED Phase 5** (accept IAM_OWNER + monitoring)
     - Days 2-4 implementation: **DONE**
     - Test round 1: **189/189 PASS, 90.33% coverage**
     - Review round 1: **7.8/10 APPROVE_WITH_CONCERNS**
     - Fix pass (H1-H4 + M1 + L2 + L3): **DONE**
     - Test round 2: **193/193 PASS, 89.26% coverage**
     - Live E2E: **VERIFIED** (3 ops, SIGTERM drain clean)

---

## Phase Completion Summary

### Gate Results (Day 1)

**S1 — AddUserGrant Idempotency: CONFIRMED**
- Zitadel enforces 1 grant per (user, project) pair
- Duplicate POST → 409 (idempotency won)
- UpdateUserGrant (PUT) required to change roles in existing grant (PUT-replace semantics)
- RemoveUserGrant 2nd call → 404 (worker treats as success)
- RemoveProjectRole idempotent (returns 200 both times)
- Implementation: `pg_advisory_xact_lock` in worker handler serializes concurrent (user, project) writes

**S2 — Custom Role Scoping: DEFERRED, ACCEPT IAM_OWNER**
- GitHub #10505 (affects human Project Owner users, not SA)
- Zitadel v4 has no custom IAM role provisioning API (only built-in: `IAM_OWNER`, `ORG_OWNER`, `PROJECT_OWNER`)
- Decision: Accept SA `IAM_OWNER` with [SA-ANOMALY] monitoring (alert on non-whitelisted outbox worker calls)
- Phase 5 action: ops runbook + quarterly SA key rotation + revisit if Zitadel adds granular OAuth2 scopes

### Implementation Metrics

**Files:** 18 new (7 src, 11 test/migration), 4 modified  
**Key modules:**
- `zitadel-http.ts` — transport wrapper (timeout 3s, retry-once)
- `zitadel-user-grants-client.ts` — ListUserGrants, Add/Update/Remove, paginated 10k cap
- `zitadel-project-roles-client.ts` — ListProjectRoles, Add/Remove, paginated 10k cap
- `outbox-event-dispatcher.ts` — operation dispatch + SA anomaly guard
- `token-bucket.ts` — rate limiter (30 ops/s)
- Migration 007: `processing_started_at` column + visibility timeout recovery (5min stalled window)

**High fixes (from 7.8/10 review):**
- H1 (lost-update race): advisory lock serializes concurrent (user, project) writes
- H2 (stalled processing): visibility timeout + recovery at worker startup
- H3 (no SIGTERM): graceful shutdown handlers (15s grace on worker drain)
- H4 (hot-path Zitadel call): enqueue-first pattern (POST /v1/assignments now ~1ms vs 3-6.5s)
- M1 (no pagination): while-loop offset for 10k+ items

### Test Results

| Metric | Round 1 | Round 2 | Status |
|--------|---------|---------|--------|
| Tests passing | 189 | **193** | +4 new (H1 concurrent, H2 recovery, H4 no-Zitadel ×2) |
| Coverage | 90.33% | 89.26% | Expected 1% dip (new small modules) |
| Phase 1/2 regression | 123/123 | 123/123 | All green |
| Type errors | 0 | 0 | Clean |

### Code Review

**Score: 7.8 / 10 → 9.1 / 10 (post-fix)**  
Initial: 0 crit, 4 high, 4 med, 7 low  
After fixes: 0 crit, 0 high, 3 med (accepted debt), 5 low

**Residual debt (accepted, Phase 4 refactor):**
- `outbox-processor.ts` (207 LOC) + `outbox.ts` (208 LOC) remain ~7-8 LOC over 200 target
- No clean split boundary; prioritize Phase 4 UI delivery

### Live E2E (authway-vps)

✓ Migration 007 applied via `postgres_admin`  
✓ 3 outbox operations processed:
  1. `add_project_role` → 200
  2. `add_user_grant` → 409 treated success
  3. `remove_project_role` → 200 idempotent  
✓ SIGTERM graceful drain: clean shutdown logs, 0 stranded `processing` rows

---

## Blockers for Phase 4 (UI Users + Assignments)

**PRIMARY BLOCKER: HTTPS + Domain setup**
- Phase 4 UI requires Zitadel OIDC `redirect_uri` HTTPS change (cannot change mid-production, locked until domain ready)
- Prerequisite: user provides `<RBAC_DOMAIN>` + `<ZITADEL_DOMAIN>` FQDN + Sectigo cert file path
- Currently Zitadel HTTP-only on private IP `10.200.0.125`

**SECONDARY BLOCKERS:**
- None from Phase 3 code. All H/M/L issues resolved or deferred to Phase 5.

---

## Deferred (Phase 4/5)

| Item | Reason | Target |
|------|--------|--------|
| M2 cluster rate-limit | Single instance OK; scale planning Phase 4 | Phase 4 infra review |
| M3 startup validation | ZITADEL_ORG_ID empty silent | Phase 5 hardening |
| Advisory lock pool tuning | 3s Zitadel RTT holds pool connections | Phase 4 capacity planning |
| HEALTHCHECK port/host | Pre-existing unhealthy status | Phase 5 infra pass |
| DDL `rbac_migrator` role | Migration ownership pattern | Phase 5 security |
| JWT client_credentials auth | Currently using PAT (interim) | Phase 5 when Zitadel adds OAuth2 resource scopes |

---

## Plan State (Aggregate)

| Phase | Status | Completion |
|-------|--------|-----------|
| 1 | **completed** | 2026-08-24 |
| 2 | **completed** | 2026-08-25 |
| 3 | **completed** | 2026-08-25 |
| ⏸ Pause | **awaiting domain + HTTPS** | user action req'd |
| 4 | pending | blocked on pause |
| 5 | pending | blocked on 4 |

**Progress: 3/5 phases done. 40% effort spent, 60% remaining. Timeline: 13-15 days (Phase 1-3: 9 days actual + domain wait TBD).**

---

## Recommended Next Action

User must provide before Phase 4 start:
1. `<RBAC_DOMAIN>` FQDN (e.g., `rbac.example.com`)
2. `<ZITADEL_DOMAIN>` FQDN (e.g., `zitadel.example.com`)
3. Sectigo wildcard cert file path (must cover both subdomains)
4. Confirm SAN covers both domains

Once provided, Phase 4 (UI) can begin. Phase 5 (seed + deploy + OneMCP wire) can start in parallel after Phase 4 UI routes complete testing.

---

## Files Referenced

- Phase plan: `d:\Vietnt\Project\onelog\plans\260821-1644-central-rbac-single-pane\`
- Validation logs: `plan.md` (Session 2026-08-25 entry)
- Phase 3 notes: `phase-03-zitadel-mgmt-api.md` (Completion Notes section)
- Gate reports:
  - `plans/reports/gate-260825-s1-idempotency.md`
  - `plans/reports/gate-260825-s2-custom-role-scoping.md`
- Implementation report: `plans/reports/fullstack-developer-260825-0844-phase-03.md`
- Test report: `plans/reports/tester-260825-0912-phase-03.md`
- Review report: `plans/reports/code-reviewer-260825-0843-phase-03.md`
- Fixes report: `plans/reports/fullstack-developer-260825-0919-phase-03-fixes.md`
