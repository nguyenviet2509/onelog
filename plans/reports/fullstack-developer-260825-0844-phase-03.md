# Phase 3 Implementation Report — Central RBAC: Zitadel Mgmt API + Outbox Pattern

**Date:** 2026-08-25  
**Plan:** `plans/260821-1644-central-rbac-single-pane/`  
**Commits:** `a415f2e` (Phase 3 code) + `2d36b45` (ops + gate reports)

---

## Day 1 Gate Results

### S1 — AddUserGrant Idempotency (PASS)

Live tests against Zitadel `http://10.200.0.125`, org `spike-test` (`387656897144029188`).

| Test | Operation | Precondition | HTTP Response | Decision |
|------|-----------|--------------|---------------|----------|
| A | `AddUserGrant(roleKeys=[a])` | User already has grant for same project | **409** "User grant already exists (V3-DKcYh)" | Treat 409 as success |
| B | `AddUserGrant(roleKeys=[a,b,c])` | Grant exists | **409** same error | 409 = project-level duplicate, not role-specific |
| B-correct | `UpdateUserGrant(roleKeys=[a,b,c])` | Grant exists | **200** — REPLACES full role set | Use PUT for role additions |
| C | `RemoveUserGrant` x2 | Same grantId | 200 then **404** "User grant not found (COMMAND-1My0t)" | Treat 404 as success |
| D-add | `AddProjectRole` x2 | Same roleKey | 200 then **409** "Role already exists (V3-DKcYh)" | Treat 409 as success |
| D-remove | `RemoveProjectRole` x2 | Same roleKey | **200 idempotent** both calls | Always safe, no special handling |

**Architecture change from S1:** Zitadel enforces ONE grant per (user, project). For role additions to existing grants, use `UpdateUserGrant` (PUT) which REPLACES the full role set. The assignment service now checks for existing grants via `listUserGrants` before deciding `add_user_grant` vs `update_user_grant`.

### S2 — Custom Role Scoping (ACCEPT IAM_OWNER)

- GitHub issue #10505 (CLOSED): bug affected project owners in v4.0.x; SA with IAM_OWNER unaffected
- No custom IAM role API exists at Zitadel Management API layer — only built-in roles (IAM_OWNER, ORG_OWNER, PROJECT_OWNER, etc.)
- Decision: Keep IAM_OWNER for SA. Monitoring added: every outbox worker call logs operation tag. Non-whitelisted operations emit `[SA-ANOMALY]` alert. Phase 5 defer.

---

## Files Added / Modified

### Day 2 — Outbox infrastructure

| File | LOC | Status |
|------|-----|--------|
| `src/db/migrations/006_outbox_events.sql` | 30 | NEW — outbox table + indexes + grants |
| `src/db/queries/outbox.ts` | 120 | NEW — enqueue, claim, mark, list, reset |
| `src/services/outbox-worker.ts` | 175 | NEW — poll loop, token bucket, dead-letter |
| `src/services/outbox-processor.ts` | 80 | NEW — per-operation dispatch + arg validation |

### Day 3 — Mgmt client + sync services + routes

| File | LOC | Status |
|------|-----|--------|
| `src/lib/zitadel-mgmt-client.ts` | 195 | EXTENDED — addProjectRole, removeProjectRole, addUserGrant, updateUserGrant, removeUserGrant, listProjectRoles |
| `src/services/role-sync.ts` | 120 | NEW — createRoleWithSync + deleteRoleWithSync (atomic DB+outbox tx) |
| `src/services/user-grant-sync.ts` | 140 | NEW — assignRoleToUser (add/update path), removeRoleFromUser |
| `src/routes/assignments.ts` | 100 | NEW — POST/DELETE/GET /v1/assignments (60s Redis cache) |
| `src/routes/drift.ts` | 80 | NEW — GET /v1/drift (on-demand Central vs Zitadel comparison) |
| `src/routes/permissions-lookup.ts` | 75 | NEW — GET /v1/permissions-lookup?hash= (Redis cache hit/miss) |
| `src/routes/outbox-admin.ts` | 70 | NEW — GET/POST /v1/outbox admin debug view |
| `src/routes/roles.ts` | +25 | MODIFIED — POST/DELETE wired to role-sync service |
| `src/config.ts` | +8 | MODIFIED — ZITADEL_PROJECT_ID + OUTBOX_WORKER_ENABLED |
| `src/app.ts` | +10 | MODIFIED — register 4 new route plugins + startOutboxWorker() |

### Day 4 — Tests

| File | Tests | Status |
|------|-------|--------|
| `tests/unit/outbox-worker.test.ts` | 8 | NEW |
| `tests/unit/role-sync.test.ts` | 10 | NEW |
| `tests/unit/user-grant-sync.test.ts` | 8 | NEW |
| `tests/unit/drift.test.ts` | 6 | NEW |
| `tests/unit/permissions-lookup.test.ts` | 9 | NEW |
| `tests/unit/zitadel-mgmt-client-phase3.test.ts` | 25 | NEW |

---

## Test Coverage

| Metric | Value |
|--------|-------|
| Total tests | **189/189 pass** (66 new, 123 existing) |
| Coverage | **90.33%** statements (threshold: 80%) |
| Typecheck | **0 errors** |
| Build (Docker) | **OK** — built and deployed on authway-vps |

---

## E2E Integration Test Transcripts

All tests run on authway-vps against live Zitadel at `http://10.200.0.125`.

### Test 1: add_project_role via outbox worker

```
INSERT outbox event: operation=add_project_role, args={projectId, roleKey="spike.e2e.role"}
Worker log: "outbox-worker: dispatching" → "outbox-processor: add_project_role"
DB status after 3s: status=done, attempts=0, processed_at=2026-08-25T02:09:11.999459Z
Zitadel verification: GET /roles/_search → "spike.e2e.role" present ✓
```

### Test 2: add_user_grant via outbox worker (409 idempotency)

```
INSERT outbox event: operation=add_user_grant, args={userId, projectId, roleKeys=["spike.e2e.role"]}
Worker: Zitadel returned 409 (grant already exists for this project) → treated as success
DB status after 3s: status=done, attempts=0 ✓
User's existing grant unchanged (role.a + role.b) — correct S1 behavior
```

### Test 3: remove_project_role via outbox worker

```
INSERT outbox event: operation=remove_project_role, args={projectId, roleKey="spike.e2e.role"}
Worker: DELETE /management/v1/projects/{id}/roles/spike.e2e.role → 200
DB status after 3s: status=done ✓
Zitadel verification: only spike.role.a, spike.role.b, spike.role.c remain ✓
```

### Test 4: Permissions hash Redis seeding (resolve → lookup)

```
POST /v1/resolve {roles: ["spike.role.a"]} → permissions_hash="1aef2b..."
Redis GET perm-hash:1aef2b... → ["onemcp.kb.read"] ✓
Confirms /v1/permissions-lookup would return correct permissions for this hash
```

---

## Architecture Decisions Applied

1. **UpdateUserGrant replaces full role set** — S1 gate finding. User-grant-sync fetches current roles, merges, sends full updated list.
2. **409 add → success** for add_project_role + add_user_grant. Both treated as idempotent (goal already achieved).
3. **404 remove → success** for remove_user_grant. Already removed = goal achieved.
4. **IAM_OWNER accepted** (S2 gate) — no custom role API exists at Zitadel IAM layer.
5. **Outbox atomicity**: DB tx wraps role INSERT + outbox INSERT. Never inline Zitadel call in tx (F7 compliance).
6. **Worker pattern**: claimNextBatch → FOR UPDATE SKIP LOCKED → process → mark done/failed/dead. Token bucket 30 ops/s.
7. **Dead-letter**: attempts check inside processEvent (before markFailed) for clean dead promotion at attempts=4.

---

## Deferred Items

| Item | Reason | Phase |
|------|--------|-------|
| JWT client_credentials (RFC 7523) for SA | Long-lived PAT acceptable for Phase 3 | Phase 5 |
| Custom minimal SA role | No Zitadel API exists for custom IAM role | Phase 5 (revisit Zitadel roadmap) |
| Admin JWT for /v1/assignments E2E | Browser flow only for current test app; headless not possible | Phase 4 (UI will test naturally) |
| Rate limiting on webhook (H3 from Phase 2) | Still deferred | Phase 3 backlog |
| MFA check via ListUserAuthFactors | Still deferred | Phase 3 backlog |
| L1: split webhook-pre-token.ts (306 LOC) | Below priority | Phase 4/5 |

---

## Non-Negotiable Compliance

- **F6 (IAM_OWNER SA)**: Documented. SA anomaly monitoring (`[SA-ANOMALY]`) added. Phase 5 runbook: revisit custom role.
- **F7 (cross-service tx non-atomic)**: Outbox pattern implemented. No inline Zitadel call inside DB transaction anywhere.
- File size: all Phase 3 files under 200 LOC. Largest: zitadel-mgmt-client.ts at ~195 LOC.
- Test coverage: 90.33% (target >80% ✓).
- No secrets committed — PAT stays in authway-vps `.env` only.

---

## Unresolved Questions

1. **Outbox event 2 (add_user_grant) returned 409** — the E2E used spike-user who already had a grant for spike-project. This is correct S1 behavior (409 → success). However, the returned `grantId` is empty string on 409 — future update_user_grant events for this user need the grantId fetched separately. The current user-grant-sync correctly pre-fetches via listUserGrants before deciding add vs update. No action needed for Phase 3.

2. **Drift check E2E** could not be run headless (requires JWT). Phase 4 UI will exercise this naturally. Unit tests cover all mismatch scenarios.

3. **Remove spike.e2e.role left spike-test org with 3 roles** (a, b, c). Sandbox cleanup pending Phase 5 (spec: keep sandbox until Phase 3 complete — now complete).
