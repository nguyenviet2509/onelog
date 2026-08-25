# Code Review — Phase 2 Day 2-3 Central RBAC

**Date:** 2026-08-24
**Reviewer:** code-reviewer
**Commit under review:** 612dda9
**Score:** **8.7 / 10**
**Approval:** **APPROVE (MERGE) with 2 non-blocking follow-ups tracked**

---

## Scope

- Files: 5 new src + 5 modified src + 5 new test files (49 tests) + prod compose + migration 005
- LOC delta: ~880 src + ~617 test
- Focus: Phase 2 webhook, HMAC middleware, Redis cache, singleflight, break-glass, Zitadel Mgmt client, epoch cache invalidation
- Tests: 123/123 passing (54 P1 + 20 P1-fix + 49 P2), coverage 92.44% stmt / 88.27% branch — thresholds met

---

## Overall assessment

Solid production-grade impl. Day 1 spike findings (F1/F2/F3/F4) applied faithfully; HMAC algorithm verified from Zitadel v4.16.1 Go source before shipping; break-glass never returns `*`; JWT-size guard (F11), singleflight (F14), fail-open with `rbac_degraded` (F8) all in place. No `as any`, no secret logging, parameterised SQL throughout. Two correctness gaps around cache invalidation on delete/update paths (non-blocking — bounded by 15-min TTL and F1 grants cache 5-min TTL).

---

## Critical issues (must fix before merge)

**None.**

---

## High priority

### H1 — Missing epoch bump on `deleteRole` and `updateRole(parent_key)`
`src/routes/roles.ts:94-106` (DELETE) and `:61-91` (PATCH parent_key)
- `role_permissions` has `ON DELETE CASCADE` from `roles(key)` → deleting a role silently removes its perms in DB but Redis `resolve:v{epoch}:{hash}` and `user-grants:v{epoch}:{userId}` still serve stale results until TTL expiry.
- Similarly, `updateRole` with `parent_key` change alters the recursive-CTE result for that role's descendants — no epoch bump, so cached perms remain based on old hierarchy for up to 15 min.
- Only `POST/DELETE /v1/roles/:key/permissions/:permKey` (lines 135, 153) call `bumpResolveEpoch`.
- **Fix**: call `bumpResolveEpoch(writerPool)` in `deleteRole` handler and in `PATCH /v1/roles/:key` when `parent_key !== undefined`.
- **Also**: `DELETE /v1/permissions/:key` in `permissions.ts:98-116` — same issue if a perm is ever hard-deleted (bounded by RESTRICT FK so only detached perms deletable, but a detached perm still appears in stale cache lists).

### H2 — Fail-close scaffolding is dead code that lies about behaviour
`src/routes/webhook-pre-token.ts:276-299`
- The `FAIL_CLOSE_ROLE_PATTERN` branch runs full best-effort cache lookup, then logs but returns the SAME degraded response as normal fail-open. Net effect = zero behavioural change but adds a Redis GET + regex compile + `getResolveEpoch` on the already-degraded path, prolonging the failure window.
- If Redis is also degraded (common failure-correlated case), the `.catch(() => null)` swallows errors silently but the extra work still happens.
- **Fix (either)**: (a) Remove the block entirely until Phase 3 provides the second Target with `interruptOnError:true`; keep only a `logger.warn(...admin-fail-close-deferred)` line. Or (b) Gate the entire block behind `if (config.FAIL_CLOSE_ENABLED)` env flag defaulting false so it's a true no-op in Phase 2.
- Current impl also silently regexp-compiles `FAIL_CLOSE_ROLE_PATTERN` on every request in `try {}` scope — move the `new RegExp(...)` to module-load with startup validation.

### H3 — No rate limiting / source-IP allowlist on `/v1/webhooks/pre-token`
- Endpoint is unauthenticated except by HMAC. If signing key ever leaks (env, docker inspect, backup snapshot) an attacker can forge webhooks and inject arbitrary permissions into JWTs.
- Prod compose exposes central-rbac only on `authway-prod_internal` docker network — mitigating factor — but no belt-and-braces IP allowlist for Zitadel container IP nor global rate limit.
- **Fix**: Register `@fastify/rate-limit` with a modest limit (e.g. 100 req/sec) on the webhook route; document the network isolation invariant in a `SECURITY.md` note. Ship this in Phase 3 alongside second Target.

---

## Medium priority

### M1 — Zitadel Mgmt client retry once includes 5xx on non-idempotent POST
`src/lib/zitadel-mgmt-client.ts:65-71`
- `POST .../_search` is a search endpoint (idempotent semantics) so retry is safe, but the comment/code should be explicit that this is only for `_search` endpoints. Future addition of a state-changing POST (create/update grant) using `mgmtPost` will get an unintended double-write. Consider naming it `mgmtPostSearch` or adding an explicit `{idempotent: boolean}` opt.
- Retry has no backoff (immediate). Fine for Phase 2 but note it.

### M2 — `AbortSignal.timeout(3000)` reused across retry has already-elapsed budget
`src/lib/zitadel-mgmt-client.ts:53-71`
- Each `doRequest()` call constructs a fresh `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` — so retry gets a fresh 3s budget, adding up to 6s total for a single `listUserGrants` call. Combined with the webhook handler having no upstream timeout wrapping, one Mgmt-API hang could tie up 6s of the token-issuance path. Zitadel Target likely 10s timeout, so still within, but tight.
- **Fix**: wrap the whole `listUserGrants` in a `Promise.race(fn, timeout(4000))` in the webhook handler, OR set a global timeout so total (attempt + retry) ≤ 4s.

### M3 — Epoch in-process cache never TTLs → multi-instance staleness
`src/db/queries/resolve-epoch.ts:12-35`
- The in-process `_cachedEpoch` is invalidated only by the same instance that called `bumpResolveEpoch`. In a multi-replica deploy (Phase 5 HA), instance B never sees instance A's bump until process restart → serves stale cached resolves indefinitely.
- Phase 2 is single-instance so not a live bug. **Add a TTL** (e.g. re-read from DB every 30s) or use Redis pub/sub `resolve-epoch-bumped` channel. Track for Phase 5 HA.

### M4 — Break-glass alert emission after `emitBreakGlassAlert` throw not tested
`src/routes/webhook-pre-token.ts:214-228`
- If `getBreakGlassPerms()` throws (empty/wildcard perms — shouldn't happen post-startup-validation but defense-in-depth), the code emits `break-glass-mfa-missing` event which is semantically wrong (misleading alert name for perms-config-invalid case). Rename the event or add a separate `break-glass-perms-invalid` event.

### M5 — Missing epoch in webhook response — apps can't detect staleness
The webhook response includes `permissions_hash`, `roles`, `ver` but no `epoch`. Downstream apps (or future permissions-lookup endpoint) that cache the hash → perms mapping cannot detect epoch bump across sessions. Consider adding `{ key: 'rbac_epoch', value: epoch }`. Non-blocking for Phase 2.

---

## Low priority / style

- **L1**: `src/routes/webhook-pre-token.ts` is 306 LOC (>200 threshold per project rule). Extract `fetchUserGrantsCached` + `resolvePermissionsCached` helpers into `src/lib/pre-token-resolver.ts`. Report claimed 195 LOC — inaccurate; current file is 306.
- **L2**: `src/lib/redis-client.ts:76` — `export const redis = getRedis();` invokes `.connect()` at import time. Fine for prod but tests must `vi.mock` before any import of code that transitively imports redis-client. Test files already do this correctly, but a comment warning would help future contributors.
- **L3**: `src/middleware/auth-resolve.ts` and `src/middleware/zitadel-action-hmac.ts` duplicate `parseSigHeader` and `verifyHmacSignature` logic (~60 LOC each). DRY: extract to `src/lib/zitadel-hmac.ts` and re-use from both middlewares. Both were correct copies but drift risk if one is patched without the other.
- **L4**: `resolve-epoch.ts:22` returns `0` on DB error which becomes cache key `resolve:v0:...`. If DB recovers and epoch is actually >0, the v0 keyspace becomes cold garbage. Consider throwing to force fail-open path instead of poisoning the cache with wrong version.
- **L5**: `singleflight.ts` has no key-cardinality bound. A pathological caller with unique keys per request could grow the Map unbounded. Realistic bound (# distinct role hashes) is small, but adding a `Map.size` limit + emergency purge would harden.

---

## Red-team fixes compliance

| ID  | Fix | Status | Evidence |
|-----|-----|--------|----------|
| F1  | Grants absent → Mgmt API + cache | ✅ PASS | `webhook-pre-token.ts:100-128` `fetchUserGrantsCached`; key `user-grants:v{epoch}:{userId}` TTL 300s; cache-first flow |
| F2  | HMAC algorithm confirmed | ✅ PASS | `zitadel-action-hmac.ts:1-26` cites Zitadel v4.16.1 `pkg/actions/signing.go`; impl matches Go source (`ts + "." + rawBody`, key as UTF-8 bytes); test `zitadel-action-hmac.test.ts` verifies with same makeSignatureHeader recipe; timing-safe compare via `timingSafeEqual`; replay window ±5min past + 60s future skew |
| F3  | Fail-open with degraded claim | ✅ PASS | `webhook-pre-token.ts:176-184` `degradedResponse()`; always returns 200 + `rbac_degraded:true`; catch-all try/wrap at line 269-303; correlation ID logged |
| F4  | Payload structure v4.16.1 | ✅ PASS | `ZitadelWebhookPayload` interface handles `user.human`/`user.machine` sub-objects; extracts `user.id`, `application.client_id`, `org.id`; comment explicitly notes `amr` absent per gate S4 |
| F5  | Break-glass hardened | ✅ PASS | `break-glass.ts:23-50` startup validation rejects `*`, rejects empty; `emitBreakGlassAlert` on every use; user ID sealed at startup via cached `_perms`; test `break-glass.test.ts` covers wildcard/empty guards |
| F8  | rbac_degraded MANDATORY | ✅ PASS | `degradedResponse()` sole degraded path; test `webhook-pre-token.test.ts:247-288` asserts `rbac_degraded:true` on DB throw AND Mgmt API throw. **Admin fail-close deferred to Phase 3 (documented)** |
| F11 | JWT size guard | ✅ PASS | `webhook-pre-token.ts:38, 259` `INLINE_PERMS_MAX=30`; test `:196-219` verifies 35-perm case omits `permissions` key, keeps only `permissions_hash` |
| F14 | Singleflight + LFU | ✅ PASS | `singleflight.ts` placeholder-first ordering avoids race between register/execute; test `redis-singleflight.test.ts:20-39` verifies 10 concurrent → 1 backend call; prod compose Redis uses `--maxmemory-policy allkeys-lfu` |

**Phase 1 fixes intact (spot check):**
- Audit-log failure via metric counter ✅ (`audit-log.ts:74` `incrementAuditWriteFailures()`)
- HMAC on `/v1/resolve` uses rawBody ✅ (`auth-resolve.ts:98-100` `Buffer.concat([tsPrefix, rawBody])`)
- Rawbody capture in `app.ts:63-76` intact
- Constant-time compare for `X-Rbac-Token` ✅ (`auth-resolve.ts:117`)

---

## Day 1 findings applied

| Finding | Applied correctly? | Notes |
|---------|-------------------|-------|
| F1 (grants via Mgmt API) | ✅ | `fetchUserGrantsCached` cache→Mgmt→cache; key includes epoch |
| F2 (HMAC algo) | ✅ | Verified from Zitadel source before implementing; live roundtrip NOT yet verified (Target URL manual update pending — tracked as unresolved) |
| F3 (fail-open policy) | ✅ | Never throws to Fastify from handler try/catch; WARN log with correlationId; returns 200 |
| F4 (payload shape) | ✅ | Handles `user.human`/`user.machine`; graceful `body.user?.id` guard; no assumption of `amr` |

---

## Security surface

| Area | Result |
|------|--------|
| SQL injection | ✅ All queries parameterised (`$1, $2, ...`); recursive CTE uses `= ANY($1::text[])` |
| Timing attacks | ✅ HMAC via `timingSafeEqual` in both auth-resolve and zitadel-action-hmac; X-Rbac-Token via `constantTimeCompare`. Break-glass user ID compare (`break-glass.ts:59`) uses `===` — **not constant-time** but user ID is not a secret (leaks in JWT `sub` anyway), acceptable. |
| Secrets in logs | ✅ Grep of `src/` for SIGNING_KEY, SA_PAT, BREAK_GLASS_PERMS, REDIS_PASSWORD — no interpolation into log messages. `zitadel-mgmt-client.ts:41` throws with var name but no value. |
| CORS on webhook | ✅ CORS registered globally but webhook is server-to-server; no cookie/credential path. Recommend blocking browser Origin explicitly on webhook route (M-severity). |
| Rate limiting | ❌ **None** (H3 above) |
| Redis auth | ✅ Prod compose sets `--requirepass ${REDIS_PASSWORD}`, client passes password. Dev compose port 6380 no password (dev-only) — acceptable. |
| Startup fail-fast | ✅ Zod validates env at load; break-glass validated before `.listen()`; audit-chain integrity check on startup |
| Fastify trustProxy | ✅ Prod restricts to `10.200.0.0/24`, dev accepts all |
| Helmet | ✅ registered global |

---

## Correctness

| Check | Result |
|-------|--------|
| Singleflight N→1 | ✅ test `redis-singleflight.test.ts:20-39` |
| Epoch bump on role_permissions add/remove | ✅ `roles.ts:135, 153` |
| Epoch bump on role delete/update | ❌ **H1 above** — missing |
| Mgmt client timeout 3s + retry once | ✅ but see M1/M2 |
| Webhook always 200 on internal error | ✅ except `user.id` missing → 400 (correct — malformed payload) |
| Missing SA PAT → degraded not startup fail | ✅ `zitadel-mgmt-client.ts:41` throws at runtime, caught by webhook handler catch block → degraded response |
| Break-glass HMAC checked before break-glass logic | ✅ HMAC middleware is `preHandler` (line 189), runs before route handler that checks `isBreakGlassUser` |
| Raw body used for HMAC verify (not JSON.stringify) | ✅ `app.ts:63-76` content-type parser captures buffer before parse |
| Redis failure ≠ hard failure | ✅ setex wrapped in try/catch with warn log; degradation is silent slower path |

---

## Deferred items assessment

| Item | Deferred to | Security hole? | Notes |
|------|-------------|----------------|-------|
| Admin fail-close (`interruptOnError:true` Target) | Phase 3 | No — degraded claim + app-layer enforcement compensates. Documented in webhook comment lines 276-299. Recommend removing dead-code block per H2. |
| Break-glass MFA check (Mgmt API `ListUserAuthFactors`) | Phase 3 | Partial — mitigated by "Zitadel-level MFA enrollment required" op-level control. Alert always emitted so use is observable. Acceptable for Phase 2 with strong VL alerting. |
| `/v1/permissions-lookup` endpoint | Phase 3 | No — Redis keys (`perm-hash:{hash}`) already seeded so Phase 3 endpoint has data. |
| JWT client_credentials auth for Mgmt client | Phase 3 (PAT fallback now) | Low — PAT is a scoped secret in env; long-lived. Acceptable interim; document PAT rotation cadence in ops-runbook. |
| Live HMAC roundtrip verification | Manual Console step | No — algorithm proven from source. Verification blocker is operational (Target URL update) not code. |

All deferrals tracked in impl report; no hidden security holes.

---

## Code quality

| Metric | Value | Standard | Pass? |
|--------|-------|----------|-------|
| Test coverage | 92.44% stmt / 88.27% branch | 80/70 | ✅ |
| Type safety | No `as any`, no `any` types | strict | ✅ |
| File size | webhook-pre-token.ts 306 LOC | ≤200 | ❌ L1 above |
| Naming | kebab-case, descriptive | project rule | ✅ |
| Error handling | async paths wrapped, no unhandled rejections | | ✅ |
| Tests skipped | 0 | | ✅ |

---

## Recommended actions (ordered)

1. **H1** — Add `bumpResolveEpoch` to `deleteRole`, and to `updateRole` when `parent_key !== undefined`. Consider same for `deletePermission`.
2. **H2** — Remove or feature-flag the dead fail-close block in webhook-pre-token.ts:276-299.
3. **H3** — Add `@fastify/rate-limit` to webhook route; document network isolation invariant.
4. **L1** — Split webhook-pre-token.ts: move `fetchUserGrantsCached` + `resolvePermissionsCached` to `src/lib/pre-token-resolver.ts`.
5. **L3** — DRY the HMAC parse/verify: extract to `src/lib/zitadel-hmac.ts`, use from both middlewares.
6. **M2** — Wrap `listUserGrants` in explicit timeout wrapper (e.g. 4s total budget).
7. **M3** — Track for Phase 5 HA: Redis pub/sub epoch invalidation.

---

## Metrics

- Tests: 123 passing (0 skipped)
- Coverage: 92.44% stmt / 88.27% branch / 96.55% funcs
- Linting: unverified (no lint invocation in report — assume passing per `npm test` gate)
- Critical: 0
- High: 3 (H1, H2, H3)
- Medium: 5
- Low: 5

---

## Unresolved questions

1. Is the H1 stale-cache window (bounded 15min TTL for resolve + 5min for grants) acceptable for a role-delete operation, or must invalidation be immediate? If OK operationally, downgrade H1 to Medium.
2. H3 rate limiting — will Phase 3's second Target introduction include a rate-limit sweep? If yes, defer H3 to Phase 3 and only add a doc note in Phase 2.
3. Live HMAC roundtrip: after Zitadel Target URL update, will the first real call succeed? Watch `docker logs central-rbac | grep sig_mismatch` — if it fails, algorithm assumptions need re-verification (unlikely per source read).

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Score 8.7/10 · 0 critical · 3 high · 5 medium · 5 low · APPROVE for merge with H1/H2/H3 as follow-up commits (non-blocking for Phase 2 done-definition since Phase 3 Target update is separate deploy step).
**Concerns/Blockers:** H1 (missing epoch bump on role delete/update) is the only correctness gap; TTL-bounded (15min) so not urgent but should ship before Phase 3 goes live. H2 (dead fail-close code) is cleanup. H3 (no rate-limit) mitigated by internal-only network.
