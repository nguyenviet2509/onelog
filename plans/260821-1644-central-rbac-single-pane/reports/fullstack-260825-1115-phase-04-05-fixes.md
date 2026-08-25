# Batch Fix Report — Phase 4-5 High Findings + Coverage Gap

**Date:** 2026-08-25  
**Scope:** 7 High findings from code-reviewer-260825-1105 + zitadel-user-search-client unit tests

---

## Finding Fix Status

| ID | Description | Status | Files touched |
|----|-------------|--------|---------------|
| H6 | `canWrite()`/`canRead()` role vs permission mismatch (BLOCKER) | FIXED | `use-permissions.ts`, `protected-route.tsx`, `utils.ts` |
| H1 | Fragile `redirect_uri.replace` + `/silent-renew` route missing | FIXED | `oidc-client.ts`, `router.tsx`, `silent-renew-page.tsx` (new) |
| H4 | `enrichGrantCounts` N×Zitadel calls per list keystroke | FIXED | `routes/users.ts` |
| H3 | Error detail leaks Zitadel internals to client on 502 | FIXED | `routes/users.ts` |
| H2 | Bulk grant no cancel/unmount cleanup | FIXED | `use-bulk-grant.ts`, `bulk-assign-dialog.tsx` |
| H5 | `onChange={() => {}}` React controlled-input anti-pattern | FIXED | `users-list-page.tsx` |
| H7 | `docker-compose.review.yml` network reconciliation risk | FIXED (deleted) | `docker-compose.review.yml` (deleted), `docs/deploy-review.md` |
| Coverage | `zitadel-user-search-client.ts` 0% → ≥80% | FIXED | `tests/unit/zitadel-user-search-client.test.ts` (new, 21 tests) |

---

## Fix Details

### H6 — Role-based auth (BLOCKER)
- Added `parseRoles(token)` to `lib/utils.ts` — extracts `roles[]` claim from JWT
- `use-permissions.ts`: added `hasRole()`, rewrote `canWrite()` / added `canRead()` to check `rbac.admin | system.root` role first, fall back to legacy perm string
- `protected-route.tsx`: `AuthorizedRoute` now calls `canRead()` instead of `hasPermission('rbac.admin.read')`

### H1 — Silent renew
- `oidc-client.ts`: replaced `.replace('/callback', ...)` with `new URL(base)` path manipulation; added `VITE_ZITADEL_SILENT_RENEW_URI` env override support
- `silent-renew-page.tsx`: new minimal page calling `userManager.signinSilentCallback()`
- `router.tsx`: registered `/silent-renew` route (public, no auth guard)

### H4 — Zitadel DoS prevention
- Removed `enrichGrantCounts` function entirely from `routes/users.ts`
- List response now returns `grant_count: null`; UI renders "—" for null
- Detail endpoint (`GET /v1/users/:id`) still returns accurate `grant_count` from Zitadel

### H3 — Error detail redaction
- Both 502 responses in `routes/users.ts` now return generic message only; Zitadel internals logged server-side, not forwarded to client
- `/v2/users` endpoint confirmed working via live curl test on authway-vps (HTTP 200)

### H2 — Bulk grant cleanup
- `use-bulk-grant.ts`: added `AbortController` ref; loop checks `signal.aborted` each iteration; `setState` calls skipped if aborted; added 100-user cap with clear error
- `bulk-assign-dialog.tsx`: `useEffect` wires `abort()` on dialog close + unmount

### H5 — Checkbox anti-pattern
- Replaced `onChange={() => {}}` with `readOnly` attribute; added comment explaining click-driven selection model

### H7 — Compose file deletion
- `docker-compose.review.yml` deleted — backend service block listed only `authway-prod_edge`, would have detached DB/Redis networks on reconcile
- `docs/deploy-review.md` rewritten: steps 5-7 now use `docker run` + `docker network connect` (additive, non-destructive)

---

## Files Modified

| File | Delta |
|------|-------|
| `central-rbac-ui/src/lib/utils.ts` | +14 LOC (parseRoles) |
| `central-rbac-ui/src/hooks/use-permissions.ts` | rewrite, 52 LOC |
| `central-rbac-ui/src/auth/protected-route.tsx` | +5 LOC (canRead swap) |
| `central-rbac-ui/src/auth/oidc-client.ts` | rewrite, 50 LOC |
| `central-rbac-ui/src/pages/login/silent-renew-page.tsx` | new, 22 LOC |
| `central-rbac-ui/src/router.tsx` | +5 LOC (route entry) |
| `central-rbac-ui/src/hooks/use-bulk-grant.ts` | rewrite, 65 LOC |
| `central-rbac-ui/src/pages/users/bulk-assign-dialog.tsx` | +9 LOC (useEffect abort) |
| `central-rbac-ui/src/pages/users/users-list-page.tsx` | +8 LOC (readOnly + null display) |
| `central-rbac/src/routes/users.ts` | rewrite, 117 LOC (removed enrichGrantCounts) |
| `central-rbac/docs/deploy-review.md` | rewrite steps 5-7 + rollback |
| `central-rbac/docker-compose.review.yml` | DELETED |
| `central-rbac/tests/unit/zitadel-user-search-client.test.ts` | new, 196 LOC, 21 tests |

---

## Test Results

| Check | Result |
|-------|--------|
| `central-rbac` typecheck | PASS (0 errors) |
| `central-rbac` tests | PASS — 214/214, 21 test files |
| `central-rbac` coverage — statements | 90.51% (threshold 80%) |
| `central-rbac` coverage — branches | 84.94% (threshold 70%) |
| `zitadel-user-search-client.ts` coverage | 100% stmts/funcs/lines, 94.87% branches |
| `central-rbac-ui` typecheck | PASS (0 errors) |
| `central-rbac-ui` build | PASS — 182 KB gzip (< 400 KB limit) |

---

## Unresolved Questions

None — all 7 High findings resolved. H3 endpoint verified live (curl 200 on authway-vps).

**Status:** DONE  
**Summary:** All 7 High findings fixed + 21-test coverage file added; backend 214/214 tests pass at 90.5% coverage; UI typechecks clean and builds to 182 KB gzip.  
**Concerns/Blockers:** None.
