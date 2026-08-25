# Phase 3 Fixes — Implementation Report

**Date:** 2026-08-25
**Source review:** `plans/reports/code-reviewer-260825-0843-phase-03.md`
**Commit:** `7ff17ef`

---

## Issues Fixed

### H1 — Lost-update race in assignRoleToUser
**Files:** `src/services/user-grant-sync.ts`, `src/services/outbox-processor.ts`, `src/db/queries/outbox.ts`

New outbox operation `add_or_update_user_grant`. `assignRoleToUser` now enqueues immediately with `{userId, projectId, roleKey}` — no Zitadel read. Worker handles `listUserGrants → decide add vs update → call Zitadel` inside a PostgreSQL advisory lock:

```sql
SELECT pg_advisory_xact_lock(hashtext('ugrant:' || userId || ':' || projectId))
```

Lock is xact-scoped; COMMIT releases it. Concurrent events for same `(userId, projectId)` serialize at DB level — second event reads state written by first → correct merged set, no dropped roles.

### H4 — Hot-path Zitadel call in assignRoleToUser (F7 breach)
Same fix as H1 — enqueue-first pattern eliminates the synchronous `listUserGrants` on `POST /v1/assignments`. Route now returns in DB write time (~1ms) instead of up to 6.5s (3s timeout + 500ms retry × 2).

### H2 — No stalled-processing recovery
**Files:** `src/db/migrations/007_outbox_processing_timeout.sql`, `src/db/queries/outbox.ts`

- New column `processing_started_at TIMESTAMPTZ` added to `rbac.outbox_events` (migration 007, applied to VPS via `postgres_admin`)
- `claimNextBatch` now also selects `status='processing' AND processing_started_at < NOW() - INTERVAL '5 minutes'` — visibility timeout pattern
- Sets `processing_started_at = NOW()` on each claim
- Worker logs recovered rows at INFO as `[OUTBOX-RECOVERED] count=N ids=[...]`

### H3 — No SIGTERM/SIGINT handler
**File:** `src/app.ts`

Registered in `main()` after `startOutboxWorker()`:
```typescript
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT',  () => { void gracefulShutdown('SIGINT'); });
```

`gracefulShutdown` calls `stopOutboxWorker(15_000)` → `app.close()` → `redis.quit()` → `writerPool.end()` → `auditorPool.end()` → `process.exit(0)`.

`stopOutboxWorker(timeoutMs)` uses `Promise.race([loopDone, timeout])` — loop signals completion via `loopDoneResolve` callback; timeout fires after 15s as safety.

VPS smoke test confirmed: `shutdown: signal received` → `outbox-worker: stopped` → `shutdown: complete` in logs on `docker restart`.

### M1 — Pagination for listProjectRoles + listUserGrants
**Files:** `src/lib/zitadel-user-grants-client.ts`, `src/lib/zitadel-project-roles-client.ts`

Both functions now loop `while(true)` with `offset += PAGE_SIZE` until `page.length < PAGE_SIZE`. Cap at `MAX_TOTAL=10_000` with `logger.warn`. Eliminates false drift mismatches for projects with >200 roles.

### L2 — File size violations
Original sizes → new structure:

| Original | LOC | Split into | LOC each |
|---|---|---|---|
| `zitadel-mgmt-client.ts` | 391 | `zitadel-mgmt-client.ts` (barrel) | 25 |
| | | `zitadel-http.ts` (transport) | 97 |
| | | `zitadel-user-grants-client.ts` | 195 |
| | | `zitadel-project-roles-client.ts` | 145 |
| `outbox-worker.ts` | 268 | `outbox-worker.ts` (loop only) | 176 |
| | | `outbox-event-dispatcher.ts` (dispatch + SA guard) | 122 |
| | | `token-bucket.ts` | 40 |

All consumers import through `zitadel-mgmt-client.ts` barrel — no import changes required in routes or other services.

**Accepted debt:** `outbox-processor.ts` (207) and `outbox.ts` (208) remain 7–8 lines over 200. No natural sub-concern to extract; forcing a split would degrade readability. Flagged for Phase 4 cleanup.

### L3 — .gitignore migration exception
**File:** `.gitignore`

Added `!central-rbac/src/db/migrations/*.sql` — future migrations no longer need `git add -f`.

---

## Files Modified

| File | Change |
|---|---|
| `src/app.ts` | SIGTERM/SIGINT handlers + import writerPool/redis/stopOutboxWorker |
| `src/db/migrations/007_outbox_processing_timeout.sql` | New — `processing_started_at` column + index |
| `src/db/queries/outbox.ts` | Add `add_or_update_user_grant` to `OutboxOperation`; add `processing_started_at` to interface; update `claimNextBatch` for visibility timeout; update all SELECT queries |
| `src/lib/zitadel-mgmt-client.ts` | Reduced to re-export barrel (25 LOC) |
| `src/lib/zitadel-http.ts` | New — extracted HTTP transport helpers |
| `src/lib/zitadel-user-grants-client.ts` | New — listUserGrants, addUserGrant, updateUserGrant, removeUserGrant (paginated) |
| `src/lib/zitadel-project-roles-client.ts` | New — addProjectRole, removeProjectRole, listProjectRoles (paginated) |
| `src/services/user-grant-sync.ts` | Enqueue-first assignRoleToUser — no Zitadel call |
| `src/services/outbox-processor.ts` | New `addOrUpdateUserGrant` handler with advisory lock; imports from granular clients |
| `src/services/outbox-worker.ts` | Import from dispatcher; stalled-row recovery log; `stopOutboxWorker(timeoutMs)` with timeout race |
| `src/services/outbox-event-dispatcher.ts` | New — processEvent + dispatch + SA anomaly guard |
| `src/services/token-bucket.ts` | New — extracted from outbox-worker |
| `tests/unit/user-grant-sync.test.ts` | Rewritten for enqueue-first contract; +5 tests (H1 concurrent, H4 no-Zitadel) |
| `tests/unit/outbox-worker.test.ts` | +2 tests (H2 recovery log, add_or_update dispatch); L4 mock assertions tightened |
| `.gitignore` | L3 — migration SQL exception |

---

## Tests Status

| Metric | Before | After |
|---|---|---|
| Tests passing | 189 | **193** |
| Tests failing | 0 | **0** |
| Coverage | 90.33% | **89.26%** |
| Type errors | 0 | **0** |

Coverage slight dip (1.07%) expected — new files (`zitadel-http.ts`, granular clients) have partial branch coverage from existing mgmt-client tests; stalled-row DB branches only exercisable in integration.

---

## VPS Deploy

- Files rsynced via `scp` to `/opt/central-rbac/src/`
- Migration 007 applied: `ALTER TABLE` + `CREATE INDEX` via `postgres_admin` (DDL owner)
- `docker compose build + up --force-recreate` succeeded
- **SIGTERM smoke test:** `docker restart` → logs show clean drain sequence → 0 stranded `processing` rows
- Health endpoint: `{"status":"ok"}` confirmed from inside container

---

## Deviations

- `outbox-processor.ts` (207 LOC) and `outbox.ts` (208 LOC) remain marginally over 200 — accepted, no clean split boundary
- VPS healthcheck reports `unhealthy` — pre-existing issue with Docker HEALTHCHECK config (not related to this patch); service responds correctly from inside container

---

## Unresolved Questions

1. VPS Docker HEALTHCHECK status `unhealthy` — appears pre-existing (present before this deploy). Root cause likely wrong host/port in healthcheck command vs actual binding. Should be investigated in Phase 4 infra pass, not blocking.
2. `outbox-processor.ts` advisory lock acquires a `writerPool` connection for the full Zitadel round-trip duration (~3s). Under sustained load, this may exhaust the pool (max 20 connections). Phase 4 should consider a dedicated connection slot or connection timeout tuning.
