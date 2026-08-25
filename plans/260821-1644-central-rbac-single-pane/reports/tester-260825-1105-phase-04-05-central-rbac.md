# Phase 4-5 Testing Report — Central RBAC

**Date:** 2026-08-25 11:05 UTC  
**Test Scope:** Phase 4 (UI), Phase 5 backend code only (not deployment infra)  
**Platform:** Windows 11, PowerShell

---

## Executive Summary

**Backend (Phase 5):**
- ✅ Typecheck: **PASS** (0 errors, 0 warnings)
- ⚠️ Tests: **PASS** (193/193 tests) but **COVERAGE THRESHOLD FAIL** — 78.83% vs 80% required
- Root cause: `src/lib/zitadel-user-search-client.ts` (167 LOC) has **0% coverage** — untested

**UI (Phase 4):**
- ✅ Typecheck: **PASS** (0 errors)
- ✅ Build: **PASS** — gzip 181.85 kB (requirement: < 400 KB)
- ✅ Lint: **PASS** — 2 known acceptable warnings (per Phase 4 plan scope trim)

| Component | Result | Status |
|-----------|--------|--------|
| Backend typecheck | ✓ pass | DONE |
| Backend unit tests | ✓ 193/193 pass | DONE |
| Backend coverage | ✗ 78.83% < 80% | **BLOCKED** |
| UI typecheck | ✓ pass | DONE |
| UI build | ✓ 181.85 KB gzip | DONE |
| UI lint | ✓ 2 warnings (acceptable) | DONE |

---

## Backend Test Results

### Unit Tests
- **Total files:** 20 test suites
- **Total tests:** 193 passed, 0 failed
- **Execution time:** 22.30s (transform 5.86s, tests 19.91s)
- **Notable:** outbox-worker tests (17.6s, 10 tests) — stress tests on concurrent outbox processing

All Phase 1-3 tests still passing. No regressions detected.

### Coverage Analysis

**Overall coverage:** 78.83% statements, 82.8% branches, 95.23% functions

| Category | File | Coverage | Uncovered Lines |
|----------|------|----------|---|
| **BLOCKER** | `lib/zitadel-user-search-client.ts` | **0%** | All (1–167) |
| lib | `zitadel-http.ts` | 85.91% | 20-21, 72-75, 92-95 |
| lib | `zitadel-project-roles-client.ts` | 85.55% | 137-138, 140-141 |
| lib | `zitadel-user-grants-client.ts` | 85.59% | 151-155, 180-183 |
| lib | `break-glass.ts` | 80% | 46, 74-75, 77-78 (edge cases) |
| middleware | `auth-jwt.ts` | 76.11% | 27-31, 79-89 (error paths) |
| middleware | `auth-resolve.ts` | 95.94% | 77-79 (rare race) |

### Coverage Threshold Status

- **Required:** 80% statements
- **Achieved:** 78.83%
- **Shortfall:** 1.17 percentage points
- **Root cause:** `zitadel-user-search-client.ts` (Phase 5 new) has NO test file

---

## UI Test Results

### Typecheck
- Command: `npm run typecheck`
- Result: **✓ PASS** — 0 errors, 0 warnings

### Build
- Command: `npm run build`
- Duration: 531ms
- Output:
  - HTML: 0.46 kB (gzip: 0.30 kB)
  - CSS: 22.63 kB (gzip: 5.23 kB)
  - JS: 591.56 kB (gzip: **181.85 kB**) ← main asset
- **Requirement:** < 400 KB gzip — **✓ PASS** (45% margin)
- Chunk warning: "chunks > 500 kB after minification" — expected warning from Vite (post-minify size; gzip 181.85 kB is well within budget)

### Lint
- Command: `npm run lint`
- Result: **✓ PASS** — 2 warnings (acceptable per Phase 4 scope trim)

```
src/components/data-table.tsx:22:17: warning react(incompatible-library)
  → Expected (react-table API limitation, documented workaround in Phase 4)

src/auth/auth-context.tsx:22:10: warning react(only-export-components)
  → Expected (auth setup pattern, acceptable per Phase 4 approval)
```

---

## Phase 5 Backend Code Review

### New Files Verified

✅ **src/lib/zitadel-user-search-client.ts** (167 LOC)
- Exports: `searchUsers()`, `getUserById()`, helper `normalizeUser()`
- Implements: /v2/users search (instance-level) + GET /v2/users/:id
- Error handling: fetch timeout 3s, 404 fallback, retry in mgmtPost
- No tests written (coverage = 0%) — **FOLLOW-UP ITEM**

✅ **src/schemas/user-schemas.ts** (605 bytes)
- Zod schemas: `listUsersQuerySchema`, `userIdParamSchema`
- Limits: q=string, limit 1–200, offset ≥ 0
- Validated in routes

✅ **src/routes/users.ts** (166 LOC)
- GET /v1/users: search + grant count enrichment (fan-out max 10 concurrent)
- GET /v1/users/:id: detail + grants, 60s Redis cache
- Auth: verifyJwt middleware, 401/502 error handling
- No tests written — **FOLLOW-UP ITEM**

✅ **src/routes/projects.ts** (32 LOC)
- GET /v1/projects: MVP hardcoded single project (per Phase 5 scope)
- Config-driven via ZITADEL_PROJECT_ID env
- No tests written — **FOLLOW-UP ITEM**

### Route Registration
✅ Verified in `src/app.ts` (lines 23–24):
```typescript
import { userRoutes } from './routes/users.js';
import { projectRoutes } from './routes/projects.js';
```
Routes registered and available at boot.

---

## Phase 4 UI Code Structure

✅ Verified scaffold complete:
- React 18 + Vite + TS
- shadcn/ui components installed (button, dialog, drawer, form, table, etc.)
- Auth: react-oidc-context setup (Phase 4 review)
- Tailwind CSS configured
- Bundle < 400 KB gzip ✓

No unit tests written for Phase 4 (per plan scope: deferred post-review).

---

## Recommendations

### 🔴 BLOCKING (coverage threshold)

**Add test file:** `tests/unit/zitadel-user-search-client.test.ts`

Minimum coverage targets for `zitadel-user-search-client.ts`:
- ✅ `searchUsers()` — query building (empty + populated q), paginate, normalization
- ✅ `getUserById()` — 404 fallback, fetch timeout, fetch error
- ✅ `normalizeUser()` — email fallback chain, display_name assembly

Estimated effort: 1–2 hours, likely +5–8% coverage → 80%+ reached.

Test structure:
```typescript
// tests/unit/zitadel-user-search-client.test.ts
describe('zitadel-user-search-client', () => {
  describe('searchUsers', () => {
    test('empty query', () => { /* ... */ });
    test('with q filter', () => { /* ... */ });
    test('paginates correctly', () => { /* ... */ });
    test('handles fetch error', () => { /* ... */ });
    test('handles 5xx response', () => { /* ... */ });
  });
  
  describe('getUserById', () => {
    test('returns user on 200', () => { /* ... */ });
    test('returns null on 404', () => { /* ... */ });
    test('handles fetch timeout', () => { /* ... */ });
    test('handles 5xx error', () => { /* ... */ });
  });
  
  describe('normalizeUser', () => {
    test('prefers human email + profile', () => { /* ... */ });
    test('fallback to machine name', () => { /* ... */ });
    test('fallback to preferred login name', () => { /* ... */ });
  });
});
```

### ⚠️ NON-BLOCKING (follow-up testing)

1. **Route integration tests** (future task)
   - Test GET /v1/users?q=test&limit=10
   - Test GET /v1/users/:id with cache hit/miss
   - Test 401/502 error responses
   - Estimated effort: 2–3 hours

2. **UI unit tests** (Phase 4 scope trim — explicitly deferred)
   - No unit tests required Phase 4
   - Plan: post-launch, recommend sampling (components, hooks, API client)

3. **E2E smoke tests** (Phase 5 deployment scope)
   - Manual test post-deploy: login → search users → grant/revoke
   - Automated E2E deferred post-phase-5

---

## Open Questions

1. **Coverage threshold enforcement:** Should we allow 78.83% coverage temporarily (1 new untested file) or block until zitadel-user-search-client tests added? (Current: blocking CI)
2. **UI unit test timing:** Do we need unit test coverage Phase 4, or acceptable to defer per scope trim?
3. **Phase 5 seed/deploy tests:** Are integration tests expected for bootstrap, drift detection, restore drill? (Identified in Phase 5 todo but deferred per "smoke test E2E" scope)

---

## Next Steps (Prioritized)

1. **[BLOCKING]** Write `tests/unit/zitadel-user-search-client.test.ts` — unblock CI/merge gate
2. Run `npm test` again → verify coverage ≥ 80%
3. Review Phase 4-5 code in dedicated review task
4. Smoke test Phase 5 deployment (post-deploy-infra added)

---

**Status:** DONE_WITH_CONCERNS  
**Summary:** All tests pass (193/193), builds succeed, but backend coverage threshold blocked by untested Phase 5 code (zitadel-user-search-client.ts). Recommend adding test file; estimated 1–2h effort. UI build/lint clean, Phase 4 scope trim confirmed (no unit tests required Phase 4).  
**Concerns/Blockers:** Coverage at 78.83% vs 80% required; zitadel-user-search-client.ts (167 LOC) has 0% coverage. Blocker for merge gate if policy enforced.
