# Code Review — Central RBAC Phase 3 (Zitadel Mgmt API + Outbox)

**Date:** 2026-08-25
**Reviewer:** code-reviewer (staff eng)
**Scope:** commits `a415f2e` + `2d36b45`
**Plan:** `plans/260821-1644-central-rbac-single-pane/`
**Impl report:** `plans/reports/fullstack-developer-260825-0844-phase-03.md`

---

## Overall Score

**7.8 / 10 — APPROVE WITH CONCERNS (MERGE_WITH_FOLLOWUPS)**

Rationale: gate findings (S1/S2) correctly applied, F6/F7 red-team mitigations honored at the DB-transaction level, outbox pattern well-structured, tests solid (90.33%, 66 new). But three real correctness/reliability issues justify follow-up before Phase 4 UI relies on this:
1. Lost-update race in `update_user_grant` merging (concurrent role adds silently drop roles)
2. No stalled-`processing` recovery + no SIGTERM handler → events can strand in-flight on crash / graceful shutdown
3. F7 partially breached on the hot path: `assignRoleToUser` synchronously calls Zitadel `listUserGrants` before enqueue (defeats "Central never blocks on Zitadel" intent, plus feeds the race in #1)

None are security holes; none block security posture. All are reliability / consistency bugs that will show up under real concurrent admin traffic. Merge acceptable if Phase 4 opens a ticket to address #1–#3 before UI ships mutations.

---

## Critical Issues

None.

---

## High Priority

### H1 — Lost-update race in `update_user_grant` role merging
**File:** `central-rbac/src/services/user-grant-sync.ts:59-108`

`assignRoleToUser` reads current roleKeys from Zitadel via `listUserGrants`, computes `mergedRoles = existing ∪ {newRole}`, then enqueues `update_user_grant` with that merged set. `updateUserGrant` semantics are PUT-replace (S1 gate finding — confirmed). Two concurrent admin requests:

- T=0: A reads grant → roleKeys=[X]. Enqueues update with [X, Y].
- T=0: B reads grant → roleKeys=[X]. Enqueues update with [X, Z].
- Worker processes A → Zitadel now [X, Y].
- Worker processes B → Zitadel now [X, Z]. **Role Y silently lost.**

Idempotency keys are different (line 82-88 hash includes `mergedRoles.sort().join(',')`), so ON CONFLICT doesn't merge them either.

**Fix options (pick one):**
1. Read authoritative roleKeys inside the worker (right before PUT), not in the API handler. Enqueue only `{userId, projectId, addRole: Y}` and let processor do read-modify-write serially. Requires worker-side serialization per (userId, projectId) — could use `SELECT ... FOR UPDATE` on a coordination row keyed on `(userId, projectId)`.
2. Use conditional PUT (Zitadel's etag/resourceVersion if available) — retry on conflict.
3. Serialize enqueues per (userId, projectId) via advisory lock (`pg_advisory_xact_lock(hashtext(userId||projectId))`) around the read-then-enqueue in `user-grant-sync.ts`.

**Impact:** silent role loss under concurrent assignments. Undetectable without drift check. Phase 4 UI will hit this the first time two admins act on the same user in <1s.

### H2 — No stalled-`processing` recovery
**File:** `central-rbac/src/db/queries/outbox.ts:82-100`

`claimNextBatch` picks rows where `status IN ('pending', 'failed')`. Rows marked `processing` (line 86) are excluded forever. If the app crashes between `UPDATE ... SET status='processing'` and `markDone/markFailed/markDead`, the event is permanently stranded — no reaper, no visibility timeout, no `processing_started_at` timestamp.

**Fix:** add `processing_started_at TIMESTAMPTZ` column set inside `claimNextBatch`. Reaper query at worker start: `UPDATE ... SET status='pending' WHERE status='processing' AND processing_started_at < NOW() - INTERVAL '5 minutes'`. Emit `[OUTBOX-STALLED]` alert.

**Impact:** compound with H3 (no SIGTERM). Under any container restart mid-batch (deploy, OOM kill, node crash), all events currently in-flight are lost silently — no metric surface, no admin visibility (they'd need to query `WHERE status='processing' AND processed_at IS NULL` manually).

### H3 — No SIGTERM/SIGINT handler; worker not drained on shutdown
**File:** `central-rbac/src/app.ts:104-136`

`main()` calls `startOutboxWorker()` at line 135 but never registers signal handlers. `docker stop` sends SIGTERM → Node exits without calling `stopOutboxWorker()` → in-flight batch strands as `processing` (see H2). Also `redis.quit()` and `pool.end()` are never called → dangling connections during rolling deploy.

**Fix:**
```typescript
async function shutdown(signal: string) {
  logger.info({ signal }, 'shutdown: draining');
  await stopOutboxWorker();      // waits for current batch
  await app.close();              // Fastify graceful close
  await redis.quit().catch(()=>{});
  await Promise.all([writerPool.end(), auditorPool.end()]);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

**Impact:** every deploy leaves stranded events until H2 is also fixed. Currently masked because prod hasn't churned.

### H4 — Synchronous Zitadel call on `/v1/assignments` POST breaks F7 intent
**File:** `central-rbac/src/services/user-grant-sync.ts:69-77`

`assignRoleToUser` calls `listUserGrants` (Zitadel Mgmt API, 3s timeout + 500ms retry) before enqueue. This is called from the POST handler (route → service → Zitadel), on the request hot path. F7 mitigation intent: "Central DB writes never block on Zitadel — outbox drains async." Here we block up to ~6.5s (3s + 500ms + 3s retry) on Zitadel during an admin mutation.

Fall-back on error is "assume no existing grant → enqueue add_user_grant" (line 76). Worker's 409-treated-as-success then hides the miss, but the hidden cost is:
- P99 latency of assignments POST tied to Zitadel availability
- Feeds H1: the pre-read is what makes lost-update possible

**Fix:** move the add-vs-update decision INTO the worker (or use idempotent PUT semantics: enqueue `add_user_grant`, worker tries POST → on 409, fetches grantId + does PUT with merged set inside a per-(user,project) serialization primitive).

---

## Medium Priority

### M1 — Zitadel Mgmt API list endpoints don't paginate
**File:** `central-rbac/src/lib/zitadel-mgmt-client.ts:139-172` (listUserGrants), `:365-391` (listProjectRoles)

Both use fixed `limit: 100` / `limit: 200` with `offset: 0` and no follow-up pages. Consequences:
- Drift endpoint (`/v1/drift`) reports false `zitadel_only` mismatches when project has >200 roles.
- `assignRoleToUser` misses existing grant if user has >100 grants (unlikely today; could bite later).
- Silent partial results — no warning that limit was hit.

**Fix:** detect result count == limit → follow-up page, or expose `hasMore` and log warning. For drift, loop until exhausted.

### M2 — Rate limiter is per-process (not cluster-safe)
**File:** `central-rbac/src/services/outbox-worker.ts:61-86`

`TokenBucket` is in-memory. If central-rbac scales to 2 replicas, effective Zitadel call rate = 60 ops/s (double the intended cap). Zitadel Mgmt API may rate-limit and start returning 429 (currently treated as 4xx → dead, no retry). Also violates SA anomaly detection principle (harder to spot bursts).

**Fix:** distributed rate limit via Redis (INCR + EXPIRE), OR document "single worker instance only" in runbook + assert with a Redis-backed leader lock in `startOutboxWorker`.

### M3 — `orgId` empty-string flow into outbox args and Zitadel headers
**Files:** `role-sync.ts:55, 108`, `user-grant-sync.ts:38`, `zitadel-mgmt-client.ts:48-54`

Default `ZITADEL_ORG_ID` is `''` (config.ts:46). All sync services do `config.ZITADEL_ORG_ID || ''`. Empty orgId flows into `x-zitadel-orgid: ` header and into outbox `args.orgId`. Zitadel may 400 or route to wrong org context. Should fail-fast at startup or reject enqueue with a clear 500 detail (currently just goes through and Zitadel yells generically).

**Fix:** at `getProjectId()` sibling `getOrgId()`, throw if empty. Or make `ZITADEL_ORG_ID` required (min-length 1) in config schema.

### M4 — `hasActiveGrantsForRole` fails open on Zitadel error
**File:** `central-rbac/src/services/role-sync.ts:167-179`

Returns `false` (no active grants) on ANY error. This is used as a pre-delete safety check. If Zitadel is unreachable, admin sees "no active grants" → proceeds to DELETE → outbox eventually removes the role → user grants referencing it are orphaned.

**Fix:** propagate error or return sentinel (throw, or `{ known: false }`). Caller should distinguish "verified no grants" from "unknown, verify manually."

Note: current call sites of this function seem unused in Phase 3 routes (only exported). If dead code, remove; if used by Phase 4 UI, must fix before ship.

---

## Low Priority

### L1 — Dead code: `seedPermHash` exported but never called
**File:** `central-rbac/src/routes/permissions-lookup.ts:35-41`

Logic duplicated inline in `resolve.ts:72-77`. Either import + use the helper, or remove the export. DRY violation.

### L2 — File-size rule violations (>200 LOC per project code standard)
- `zitadel-mgmt-client.ts` — **391 LOC** (impl report claimed 195 — inaccurate)
- `outbox-worker.ts` — **268 LOC** (impl report claimed 175)
- `user-grant-sync.ts` — 206 LOC
- `routes/roles.ts` — 203 LOC
- `db/queries/outbox.ts` — 200 LOC (at threshold)

Suggested splits:
- `zitadel-mgmt-client.ts` → `zitadel-http.ts` (mgmtPost/Delete/Put + headers) + `zitadel-mgmt-client.ts` (public API only).
- `outbox-worker.ts` → `token-bucket.ts` + `outbox-worker.ts`.

### L3 — `.gitignore` `*.sql` blanket rule
**File:** `d:/Vietnt/Project/onelog/.gitignore:25`

Blanket `*.sql` forces `git add -f` on every new migration. Add exception: `!central-rbac/src/db/migrations/*.sql`. Current migrations 001–006 were force-added; future migrations will hit the same friction.

### L4 — Outbox worker test mocks pool arg as `{}` — signature-drift blind spot
**File:** `central-rbac/tests/unit/outbox-worker.test.ts:102, 119, 149`

Asserts `markDone(pool, id)` receives `({}, '1')`. Real pool object works, empty `{}` masks accidental arg swaps in test refactor. Tighten: `expect(mockMarkDone).toHaveBeenCalledWith(expect.anything(), '1')` or import `writerPool` mock target.

### L5 — Token bucket rate-limiter can burst above 30/s under skew
**File:** `central-rbac/src/services/outbox-worker.ts:71-85`

`refill = Math.floor((elapsed / 1000) * opsPerSec)` and `Math.min(opsPerSec, tokens + refill)` cap the bucket at 30. But bucket starts full (30), so first tick allows 30 ops immediately, then refill continues. Within a 2s window, 60 ops possible. Acceptable if Zitadel can handle 30/s sustained + short bursts; document expected burst tolerance.

### L6 — Assignments DELETE: user_id required in query, not enforced by zod
**File:** `central-rbac/src/routes/assignments.ts:94-98`

Query schema `revokeQuerySchema` only defines `role_key`. `user_id` is fetched from `rawQuery` bypassing zod. Move into schema for consistent validation + typed access.

### L7 — Enqueue `orgId` denorm risks staleness
**File:** `central-rbac/src/db/queries/outbox.ts:46-73`

`orgId` is captured into `args` JSONB at enqueue time. If admin changes `ZITADEL_ORG_ID` config between enqueue and worker processing, outbox event uses stale orgId. Low risk (orgId rarely changes), but worth a code comment.

---

## Day 1 Gate Findings — Applied Correctly? ✅

| Gate | Finding | Applied at | Status |
|------|---------|------------|--------|
| S1 | addProjectRole 409 → success | `zitadel-mgmt-client.ts:199-202` | ✅ |
| S1 | removeProjectRole 200 idempotent | `zitadel-mgmt-client.ts:219-241` (no special-case needed, works as-is) | ✅ |
| S1 | addUserGrant 409 → success | `zitadel-mgmt-client.ts:273-276` | ✅ |
| S1 | updateUserGrant PUT replaces roles | `zitadel-mgmt-client.ts:295-318`, caller supplies complete set at `user-grant-sync.ts:81` | ✅ (but see H1 — the "complete set" is racy) |
| S1 | removeUserGrant 404 → success | `zitadel-mgmt-client.ts:341-344` | ✅ |
| S1 | Pre-check via listUserGrants (add vs update) | `user-grant-sync.ts:70-74` | ⚠️ works, but on hot path (H4) |
| S2 | No custom-role provisioning | not present ✅ | ✅ |
| S2 | `[SA-ANOMALY]` monitoring | `outbox-worker.ts:103-109` (whitelist check → dead + alert) | ✅ |

**Verdict:** S1/S2 correctly applied. H1 (concurrent update race) is a downstream consequence of the S1 add/update pattern, not a misapplication.

---

## Red-Team Compliance

| Finding | Mitigation | Status |
|---------|------------|--------|
| **F6** IAM_OWNER SA | PAT via `ZITADEL_SA_PAT` env only (`config.ts:45`); never logged (grep confirmed); operation whitelist + `[SA-ANOMALY]` alert (`outbox-worker.ts:51-57, 103-109`); Phase 5 deferred documented in header comment (`zitadel-mgmt-client.ts:15`) | ✅ |
| **F7** Cross-service tx non-atomic | `role-sync.ts:58-87` uses `BEGIN...INSERT role...INSERT outbox...COMMIT` with `ROLLBACK` on error; no `fetch()` call inside `client.query(...)` scope; outbox worker consumes async | ✅ (mutation path). ⚠️ read path: `user-grant-sync.ts:70` calls Zitadel synchronously on hot path — see H4 |
| **F3** azp verification | `auth-jwt.ts:97-100` rejects mismatched azp | ✅ (Phase 2, still holding) |
| **F4** Resolve auth mandatory | `resolve.ts:23` `preHandler: verifyResolveAuth` | ✅ |
| **C2** raw body HMAC | `app.ts:68-81` capture rawBody before JSON.parse | ✅ |
| **H1** trustProxy | `app.ts:44` restricted to 10.200.0.0/24 in prod | ✅ |
| **H2** CORS allow-list | `app.ts:52-60` env-driven | ✅ |

---

## Outbox Pattern Correctness

| Aspect | Impl | Verdict |
|--------|------|---------|
| Migration 006 partial index on `(status, created_at) WHERE status IN ('pending','failed')` | `006_outbox_events.sql:24-26` | ✅ |
| `claimNextBatch` uses `SELECT ... FOR UPDATE SKIP LOCKED` | `outbox.ts:87-94` | ✅ |
| Idempotency: unique `idempotency_key` + ON CONFLICT DO NOTHING | `006_outbox_events.sql:11` + `outbox.ts:56` | ✅ |
| Rate limit: token bucket 30 ops/s (not naive setInterval) | `outbox-worker.ts:61-86` | ✅ (but see L5 burst + M2 cluster) |
| Dead-letter: attempts >= 5 → `dead` + `[OUTBOX-DEAD]` alert | `outbox-worker.ts:138-144, 220-223` | ✅ |
| Retry backoff on 5xx | 500ms in-client retry (`zitadel-mgmt-client.ts:75-77`) + worker re-queues to `failed` (no delay before next claim) | ⚠️ next claim can happen 1s later (POLL_INTERVAL) — no exponential backoff, tight loop possible if failure persists |
| `rbac_writer` grants on outbox table | `006_outbox_events.sql:33-34` | ✅ |
| Worker starts via `startOutboxWorker()` behind `OUTBOX_WORKER_ENABLED` | `app.ts:135` + `outbox-worker.ts:240-254` | ✅ |
| Graceful shutdown drains in-flight | `stopOutboxWorker` exists but not wired to SIGTERM | ❌ **H3** |
| Stalled `processing` recovery | none | ❌ **H2** |
| SQL injection: parameterized queries | all queries use `$N` placeholders | ✅ |

---

## Security Surface

| Check | Verdict |
|-------|---------|
| No `ZITADEL_SA_PAT` in logs (grep) | ✅ |
| All mutation routes behind `verifyJwt` | ✅ (`assignments.ts:45, 82`, `outbox-admin.ts:33, 50, 62`, `roles.ts:42, 77, 115, 152`) |
| Audit log on all mutations (create/delete/retry) | ✅ (`assignments.ts:65-70, 114-119`, `outbox-admin.ts:81-86`, `roles.ts:69-72, 134-137`) |
| Zod validation on all inputs | ✅ (all routes) |
| Permissions-lookup hash validated as 64-char hex | ✅ (`permissions-lookup.ts:45`) |
| Drift endpoint auth + no PII leak | ✅ (returns only role_key set-difference, no user data) |
| SQL parameterized (no string interpolation) | ✅ (grep for `${` in query strings — clean) |
| Rate limit on assignments/drift/permissions-lookup | ❌ none in-app; presumably behind reverse-proxy — DOCUMENT explicitly for Phase 5 |

**Verdict:** no security holes. Rate-limit deferral to reverse-proxy is acceptable IF documented as an assumption; currently not.

---

## Correctness — Additional Spot Checks

- `role-sync.ts:112-122` — the `if (orgId)` block is dead code (only logs debug + wrapped in try/catch that does nothing). Remove.
- `role-sync.ts:130-138` — `deleteRoleWithSync` returns `{ deleted: false, outbox: {id:'0', ...} }` on role-not-found. Fake outbox `id='0'` is misleading in response and audit log. Return `outbox: null` instead.
- `outbox-processor.ts:78-87` — `addUserGrant` returns `grantId` but caller (`outbox-worker.ts:154-175`) discards it. On new grant creation, grantId is lost and never persisted anywhere. Future `update_user_grant` on same user has to `listUserGrants` again to recover. Consider writing back to outbox `args` or a `zitadel_grant_id` column on assignments table.

---

## Code Quality

- File sizes: see L2 above.
- Naming: kebab-case + descriptive ✅.
- No `any` in inspected files ✅ (uses `unknown` + type-guards properly).
- Comment quality: excellent — S1 findings inlined in file headers.
- Type-check clean per impl report ✅.
- Test coverage 90.33% ✅. Spot-check confirms tests exercise real code paths (rollback verification in `role-sync.test.ts:103-112`; add-vs-update branching in `user-grant-sync.test.ts:33-95`).

---

## Deferred Items — Assessment

| Item | Impl-report reason | Reviewer verdict |
|------|-------------------|------------------|
| JWT client_credentials for SA (Phase 5) | Long-lived PAT OK for now | ✅ acceptable — document PAT rotation runbook (mentioned in S2 gate but not in code) |
| Custom minimal SA role (Phase 5) | Zitadel API doesn't expose | ✅ accurate finding |
| Admin JWT E2E for /v1/assignments (Phase 4) | Browser flow only | ✅ acceptable — will exercise in Phase 4 UI |
| Rate limit on webhook (Phase 3 backlog) | Still deferred | ⚠️ backlog longer than expected; add ticket |
| MFA check via ListUserAuthFactors | Still deferred | ⚠️ Phase 5 must actually happen; add ticket |
| Split webhook-pre-token.ts (306 LOC) | Below priority | ⚠️ 278 LOC now — still needs split |

---

## Spec Deviations

| Spec assumption | Reality | Correct handling? |
|----------------|---------|-------------------|
| addUserGrant merges roles (spec) | S1: 409 on duplicate, PUT replaces (`updateUserGrant`) | ✅ Correct — pivoted to add/update path |
| CENTRAL_RBAC_MANAGER custom role | Zitadel Mgmt API has no custom-IAM-role endpoint | ✅ Correct — accept IAM_OWNER with monitoring |
| `*.sql` gitignore + `git add -f` on migrations | Root `.gitignore` has `*.sql` blanket rule; migrations committed via `-f` | ⚠️ Add `!central-rbac/src/db/migrations/*.sql` exception (L3) |

---

## Positive Observations

- Excellent inline documentation: S1 gate findings referenced in file headers (`zitadel-mgmt-client.ts:8-13`, `outbox-worker.ts:6-11`). Future readers won't need to hunt down the gate report.
- Clean separation: `outbox-processor.ts` per-operation handlers isolate arg validation from HTTP transport, from worker loop control. Composable.
- `enqueueOutbox` ON CONFLICT DO NOTHING is textbook idempotency at the DB layer.
- Test structure: mocks are hoisted properly, `vi.clearAllMocks()` in beforeEach — no cross-test leakage.
- `TokenBucket` implementation is dependency-free and correct (no `p-throttle` added — YAGNI honored).

---

## Recommended Actions (Priority Order)

**Before Phase 4 UI mutations ship:**
1. **[H1]** Fix lost-update race in `assignRoleToUser` (advisory lock OR move read into worker with per-(user,project) serialization).
2. **[H2 + H3]** Add SIGTERM handler + stalled-`processing` reaper (`processing_started_at` column + startup sweep).
3. **[H4]** Reconsider hot-path Zitadel call — either accept as design (document latency) or move to worker.

**Before public rollout:**
4. **[M1]** Paginate `listProjectRoles` and `listUserGrants` (or expose `hasMore` + warn).
5. **[M2]** Redis-backed leader lock or distributed rate limit (or document single-worker invariant).
6. **[M3]** Fail-fast on empty `ZITADEL_ORG_ID` at startup.
7. **[M4]** Fix `hasActiveGrantsForRole` fail-open (or remove if dead).

**Housekeeping:**
8. **[L1]** Remove `seedPermHash` or replace inline block in resolve.ts.
9. **[L2]** Split oversized files per code standards.
10. **[L3]** Update root `.gitignore` with migrations exception.
11. **[L4]** Tighten worker test mock assertions.
12. **[L6]** Move `user_id` into zod schema for DELETE /v1/assignments.

---

## Metrics

- **Files reviewed:** 12 source + 6 test files
- **New LOC (Phase 3):** ~1,600 (routes + services + client + migration + tests)
- **Test coverage:** 90.33% (target 80%) ✅
- **Type-check errors:** 0 ✅
- **Critical issues:** 0
- **High-priority issues:** 4 (H1–H4)
- **Medium:** 4 (M1–M4)
- **Low:** 7 (L1–L7)

---

## Approval

**MERGE_WITH_FOLLOWUPS**

Phase 3 code is production-safe for the Zitadel-write path (F6/F7 mitigated at DB tx layer). No security holes, no data-loss on the happy path. H1–H3 are real reliability bugs but manifest only under specific conditions (concurrent admins on same user, crash mid-batch, graceful shutdown of container). These conditions are guaranteed to hit in Phase 4 when the UI ships — must be fixed before UI mutations go live. Create tickets for H1–H4 with target = pre-Phase-4-cutover.

Score: **7.8 / 10**.

---

## Unresolved Questions

1. **Is central-rbac intended to run as a single instance or with multiple replicas?** If HA is planned, M2 (distributed rate limit) becomes blocking. Impl report doesn't address.
2. **Is `hasActiveGrantsForRole` actively used by any consumer?** Exported from `role-sync.ts` but no imports found in Phase 3 routes. If dead, delete. If Phase 4 UI relies on it, M4 becomes blocking.
3. **PAT rotation runbook location?** S2 gate mentions "quarterly PAT rotation" but no ops doc committed. Confirm doc-manager will write this before Phase 5.
4. **Zitadel `x-zitadel-orgid` semantic when SA is IAM_OWNER:** does it need to match the user grant's orgId, or is it advisory? Impact on M3 severity depends on this.

---

**Status:** DONE_WITH_CONCERNS
**Summary:** 7.8/10 · 0 critical · 4 high · 4 medium · 7 low · APPROVE with follow-ups (H1–H4 to fix before Phase 4 UI mutations ship)
**Concerns/Blockers:** H1 (lost-update race in concurrent role assignments), H2 (no stalled-processing recovery), H3 (no SIGTERM handler → strand events on deploy), H4 (F7 partially breached on hot path — synchronous Zitadel call in `assignRoleToUser`). None are security holes; all are reliability bugs surfaced by concurrent traffic or container churn.
