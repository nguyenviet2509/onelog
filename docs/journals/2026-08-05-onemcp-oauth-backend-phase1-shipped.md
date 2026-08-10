# OneMCP OAuth Backend Phase 1: Shipped with Security Compromise

**Date**: 2026-08-05 09:30
**Severity**: Medium
**Component**: OneMCP OAuth / Session Management
**Status**: Ready for user approval push

## What Happened

Phase 1 (backend OAuth + session management) for GitLab SSO completed: 7 new auth service files, 7 modified core files, 102/102 tests passing, 0 regressions. Code review approved with changes. Chef committed locally to OneMCP repo (hash 4d918a7). Push pending user approval.

## The Brutal Truth

We shipped a security concession and buried it. Trust-header mode in SSO-only phase accepts requests from any source claiming to be the bridge — bridge API key validation deferred to Phase 3. This is a controlled exposure window (bridge runs in isolated VPC, auth mode toggles cleanly), but it's still a gap. The alternative (require API key + trust-header together now) would block the stage gate by forcing Phase 3 work into Phase 1. We chose the gap.

The bigger frustration: TLS cert for public IP SAN still missing. Can't actually run the OAuth redirect against 202.92.5.113 from external GitLab servers until that cert lands. We have the code path, but no way to test it in staging. User holds the cert provisioning thread.

## Technical Details

**Implemented:**
- `auth.service.ts`: GitLab OAuth flow (code → token → user info fetch)
- `session.service.ts`: Cookie-based session with secure flag gated to production (`NODE_ENV === 'production'`)
- `auth.controller.ts`: GET /api/auth/gitlab/callback (query validation, session issue)
- `cookie-auth.middleware.ts`: Validates bearer cookie, populates req.user
- `trust-user.middleware.ts`: In trust-header mode, accept upstream Authorization header as user identity (no CIDR validation)
- Tests: 17 new (auth flow, session lifecycle, callback validation), 85 existing + 0 broken

**Code Review Changes Applied:**
- H1 (HIGH): Cookie secure flag was hardcoded `true` — broke local http dev. Fixed to gate on `NODE_ENV === 'production'`. This is correct but means staging (which may run on http) also accepts insecure cookies. Trade-off acknowledged.
- M2 (MEDIUM): Pino logger redacts cookie headers at app.module.ts:40 — already covers the risk, no additional fix.
- M6 (MEDIUM): Trust-header without CIDR validation in SSO mode. Waived per plan pivot 260727 (Phase 3 will add API key + CIDR). Documented in phase-01.md as "Exposure window: Phase 1 end-state"

**Non-blocking backlog (Phase 2+):**
- parseCookie DRY violation (M1)
- URL-decode missing on callback query params (M5)
- env.schema.ts superRefine overcomplicated (L1)

## What We Tried

1. **Initially proposed** secure flag `true` always → broke local dev cycle (npm run start hits http://localhost:3000)
2. **Moved to** NODE_ENV gate → satisfies both prod TLS + local http dev, shipping approved
3. **Auth mode options:**
   - Option A: Require API key + trust-header now → delays Phase 1 ship by 3+ days (forces Phase 3 work)
   - Option B: Trust-header only in Phase 1 → accepts Option A's security gap but unblocks Phase 2 portal UI work
   - **Chose B** per plan pivot (risk mitigated by VPC isolation + clean Phase 3 cutover)

## Root Cause Analysis

Security compromise exists because the plan made a hard call: **GitLab OAuth is worthless if the bridge can't reach it**. Bridge API key validation (currently in Phase 3) was the real blocker preventing Phase 1 in earlier iterations. User pivoted mid-planning (260727 meeting notes): "Ship trust-header in Phase 1 as-is, migrate to API key in Phase 3 when bridge goes prod." This is a reasonable risk trade-off (you get user auth without internal credential leakage), but we didn't surface the security posture clearly enough in the journal — buried it in code review waiver notes.

Cert blocker is simple: VPS TLS cert for 202.92.5.113 requires DNS + ACME, which user owns. We can't test the actual OAuth callback redirect without it.

## Lessons Learned

1. **Surface security trade-offs explicitly early.** "Trust-header mode accepts any bearer header" should have been stated in Phase 1 spec, not discovered in code review. Put it in the handoff doc so staging QA knows what they're testing.

2. **Cookie secure flag + environment gating is standard practice.** Hardcoding `true` was a junior mistake, but Node/Express cookie patterns do this routinely. Should have been code-reviewed before shipping (lesson: pair-review crypto/auth paths before merge).

3. **External dependency (TLS cert) blocks E2E testing.** We built the full OAuth flow but can't prove it works at 202.92.5.113. Recommend: Stage with a wildcard cert or temp self-signed SAN, then swap to prod cert in Phase 3. User may not have prioritized this, but it's a hard stop for staging gate.

4. **Phase 3 "cutover" language is misleading.** API key migration isn't a simple config swap—it's a breaking change for any client not using the bridge. Document the migration path for Phase 3 (bridge API key is auto-issued? Manual? Rotated how?).

## Blockers & Next Steps

**Blocking staging E2E:**
- TLS cert for 202.92.5.113 not yet provisioned. OAuth redirect from external GitLab → this IP requires valid cert.
  - **Action**: User patches cert path in .env, or provisions via VPS infra team. Non-trivial but user-owned.

**Blocking push to origin/master:**
- User approval required. Commit is locally staged in OneMCP repo (D:/Vietnt/Project/onemcp, hash 4d918a7).
- **Action**: `git push` after user reviews journal + code.

**Phase 2 gates** (portal login UI, 1–2 days):
- Requires this Phase 1 commit merged + published to NPM (if applicable) or integrated via monorepo symlink

**Phase 3 gates** (bridge migration + prod cutover, 1–2 days):
- Bridge API key generation endpoint (OneMCP backend new)
- CIDR-aware trust-header validation (auth.middleware)
- Prod rollout plan (single toggle, rollback procedure)

Unresolved Q: How many external clients (if any) currently consume old trust-header without API key? If zero, Phase 3 is purely internal. If >0, may need deprecation window.
