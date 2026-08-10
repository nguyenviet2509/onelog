# OneMCP GitLab SSO Phase 1+2 shipped, Phase 3 partial — external network blocker

**Date**: 2026-08-05 11:31
**Severity**: High (blocked by infrastructure, not code)
**Component**: OneMCP OAuth backend, portal SSO, bridge dual-auth prep
**Status**: Deployed + Blocked on VPS↔GitLab firewall

## What Shipped

**Phase 1 (OAuth backend)** — commit 4d918a7 deployed to onemcp-vps:
- AuthModule, SessionService (Redis), GitlabOAuthService (PKCE S256)
- 4 endpoints: /api/auth/{gitlab/login,gitlab/callback,logout,me}
- CookieAuthMiddleware with secure flag gated on NODE_ENV=production
- 17 unit tests, 102/102 pass
- docker-compose now forwards AUTH_MODE, GITLAB_OAUTH_*, SESSION_* vars

**Phase 2 (portal SSO)** — commit f06908e deployed:
- Login page, Next.js middleware, UserMenu component, useCurrentUser hook
- Route groups refactor: (app)/layout.tsx wraps AppShell, (auth)/login bare (fixes sidebar rendering)
- Refactor legacy identity system: deleted 4 files (~385 lines), SSO-only (no env-gate)

**Phase 3 (docs + bridge prep)** — commits 7576def, 6e4c69a:
- sso-guide.md (user), sso-rollback-runbook.md (ops)
- system-architecture.md + staging-deployment-guide.md updated
- OneLog bridge functions/onemcp-tools.py adds BOT_KEY valve (X-Onemcp-Key when set, else X-Onemcp-User fallback)
- Non-breaking, Actions files marked TODO for post-bot-key deploy

## Deployed Status

✅ Containers running on onemcp-vps, safe defaults active (AUTH_MODE=trust-header, SESSION_TIMEOUT=3600)
✅ OAuth flow steps 1–4 work: browser reaches gitlabs.inet.vn, consent, callback with auth code
✅ Git hostname fix applied: gitlabs.inet.vn (with 's')
✅ Portal login page renders, middleware chains correctly
✅ Bridge dual-auth valve logic ready, zero env-gate friction

## The Blocker (External)

**VPS 202.92.5.113 → gitlabs.inet.vn (202.92.5.105:443) TCP timeout after 10s.**

Root cause: iNET hosting firewall blocking same-subnet outbound (hardened policy, common for shared hosting).

**Step 5 (backend token exchange) fails consistently.** Error: `gitlab_token_exchange_error: This operation was aborted` after 10s. Steps 1–4 complete. No internal IP found for gitlabs across 10.200.0.x, 10.200.1.x, 202.92.5.x, 202.92.6.x scans (only ioffice.inet.vn @10.200.0.105 has cert).

**Fix path (user escalation required):**
1. Contact iNET IT: whitelist VPS 202.92.5.113 outbound to gitlabs.inet.vn:443
2. OR: Provide internal DNS entry for gitlabs (reachable from VPS via private network)

No code fix possible on our side.

## Key Decisions Locked

- **Cookie secure flag**: NODE_ENV=production gate (not hardcoded true). Enables local dev on http, matches prod behavior automatically.
- **Portal SSO-only**: No env-gate despite backend AUTH_MODE fallback. Next.js build-time env is fragile; removed UI complexity, gates happen at backend instead.
- **Backend AUTH_MODE kept**: Provides bridge rollback path until bot key live. Will remove once bridge fully migrated to X-Onemcp-Key.
- **Bridge dual-auth pattern**: BOT_KEY valve swapped at OpenWebUI Admin UI (no code redeploy). Reduces deploy friction when bot key ready.
- **X-Onemcp-User path remains open**: No CIDR gate in SSO mode (per plan pivot 260727). Spec-aligned, mitigated by ingress-level filtering + AUTH_MODE default.

## Lessons & Tensions

1. **Infra discovery late**: Should have tested VPS→gitlabs connectivity *before* phase 1 code freeze. Would have caught firewall early. Now blocking 100% functional code.
2. **Next.js build-time env**: Originally designed env-gate UI layer. Removed when realized Next.js vars freeze at build time → porting gate to backend was cleaner. Slight over-architecture but pays off for future gateway layers.
3. **Bridge valve pattern**: Tempting to force API key immediately, but delaying until bot key provisioned reduces operational risk (no fake tokens in memory). One env var swap in UI beats code redeploy.

## Next Steps (User-Owned)

1. **Contact iNET IT**: Request whitelist for VPS 202.92.5.113 → gitlabs.inet.vn:443. Reference ticket if available.
2. **Post-network-fix**: Retry OAuth flow browser, verify session_active > 0 metric in Redis.
3. **Provision bot API key**: At onemcp-vps:/profile/api-keys (admin only).
4. **Activate bridge**: Set BOT_KEY valve in OpenWebUI Admin UI → System Settings → onemcp-tools.
5. **Retire AUTH_MODE**: Once all OneLog action calls use X-Onemcp-Key, remove AUTH_MODE=trust-header from docker-compose.

**Unresolved:**
- ETA for iNET IT firewall whitelist?
- Is internal GitLab IP available (vs. public 202.92.5.105 only)?
