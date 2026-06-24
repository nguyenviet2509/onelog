# Phase 02 — SSO OIDC + Real Auth

## Context
- [plan.md](plan.md) | [Brainstorm §Stage 2](../reports/brainstorm-260623-1617-production-rollout.md)
- Replaces Phase 09 trong MVP plan

## Overview
- Priority: P0
- Status: pending
- Effort: 3-5 ngày
- Mục tiêu: Gỡ anonymous session (`auth-stub`), plug Corp OIDC. Role-based access cho `/admin/*`. Agent zero-trust nhận `X-User-Id` từ Web BFF only.

## Requirements
- OIDC client_id + secret + discovery URL từ corp IdP (Phase 00)
- NextAuth.js v5 (Auth.js)
- Postgres `users` table extend: `oidc_sub`, `role` (admin/viewer)
- Session cookie httpOnly secure samesite=lax
- API route guard middleware
- Agent reject request không có `X-User-Id` header (chỉ qua Web BFF)

## Related files
- `web/src/lib/auth-stub.ts` — **delete**, replace by `web/src/lib/auth.ts`
- `web/src/lib/auth.ts` — **create** (NextAuth config)
- `web/src/app/api/auth/[...nextauth]/route.ts` — **create**
- `web/src/middleware.ts` — **create** (route guard)
- `web/src/db/schema.ts` — extend `users` table (add oidc_sub unique, role enum)
- `web/src/db/bootstrap.ts` — add ALTER TABLE migration block
- `web/src/app/api/chat/route.ts` — replace `getCurrentUser()` với session check
- `web/src/app/api/conversations/route.ts` + `[id]/route.ts` — guard
- `web/src/app/api/admin/*` — guard + role=admin check
- `web/src/components/chat/sidebar.tsx` — show user email + logout
- `web/src/app/login/page.tsx` — **create** (OIDC redirect)
- `agent/src/agent/auth.py` — **create** (verify X-User-Id presence + format)
- `agent/src/agent/main.py` — add auth middleware

## Implementation steps
1. Install `next-auth@5` (Auth.js) + `@auth/drizzle-adapter`
2. Configure NextAuth `OIDCProvider` với corp IdP
3. Drizzle adapter setup → auto-create user record on first login
4. Add `role` column với default `viewer`, manual `UPDATE` cho admin
5. Middleware: protect `/`, `/chat`, `/admin/*`, redirect to `/login` nếu chưa auth
6. Update all API routes: replace `getCurrentUser()` → `await auth()` session
7. `audit_log.user_id` lấy từ session.userId thật
8. Agent: middleware reject nếu `X-User-Id` missing/invalid format. Trust Web BFF qua docker network.
9. `/admin/*` routes: `if (session.user.role !== "admin") return 403`
10. Sidebar: render `{session.user.email}` + logout button
11. E2E test: login → chat → check audit_log user_id correct

## Todo
- [ ] NextAuth.js installed + OIDC provider configured
- [ ] Drizzle adapter + schema extended
- [ ] Middleware guards in place
- [ ] All API routes use real session
- [ ] Agent auth middleware
- [ ] Login page + logout
- [ ] Role-based /admin gate
- [ ] E2E test pass (login 2 user, 1 admin 1 viewer)

## Success criteria
- Login flow corp OIDC work end-to-end
- Unauthorized request `/api/*` returns 401
- viewer user truy cập `/admin/audit` returns 403
- audit_log rows có user_id thật (không phải hard-code 1)
- Agent reject curl direct không có `X-User-Id`

## Risks
- IdP chưa sẵn → fallback Caddy `basic_auth` (htpasswd) tạm + audit thủ công
- NextAuth v5 còn beta API → pin version, đọc release notes
- OIDC discovery URL internal có thể block → cần allow firewall

## Security
- Session cookie: httpOnly, secure, samesite=lax, max-age 8h
- CSRF protection auto via NextAuth
- Agent endpoint binding internal docker network only (không expose 8080 ngoài)
- Audit user role changes (manual SQL update logged ngoài app)

## Next steps
Phase 05 (real LLM) dùng user_id thật cho per-user budget.
