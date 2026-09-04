# OneMCP GitLab SSO — brainstorm design

**Date:** 2026-07-27
**Author:** trihd@inet.vn
**Status:** Design agreed — plan pending user confirmation

## Bối cảnh

OneMCP hiện dùng "v1 pre-auth" — `X-Onemcp-User` header + IP CIDR gate. Portal có UI "Identified as admin" chip cho phép claim identity thủ công. Đây là gap **duy nhất** trong 9 requirements gốc (audit đầy đủ ở phần dưới).

## Audit 9 requirements gốc

| # | Requirement | Status | Ghi chú |
|---|---|---|---|
| 1 | MCP server multi-dept | ✅ DONE | v1 pilot Kỹ thuật + v1.5 Ops/Support (`spaces` table) |
| 2 | **iNET SSO hoặc GitLab SSO** | ❌ **GAP** | Focus doc này |
| 3 | Phân quyền | ✅ DONE (RBAC 5-role) + ⚠️ manual env (`MAINTAINER_USERNAMES`) |
| 4 | Skills + artifacts CRUD | ✅ DONE | 8 MCP tools + portal |
| 5 | Lưu trữ lâu dài | ✅ DONE | Postgres + MinIO + daily backup |
| 6 | Audit | ✅ DONE | `audit/` module + interceptor |
| 7 | Contribute skills qua git | ✅ DONE | GitLab HMAC + `*/15` cron |
| 8 | Contribute artifacts + DB | ✅ DONE | Postgres + versioning + review |
| 9 | AI viết template + wrap-up | ✅ DONE | Zod schemas + `session-wrapup` hook |

**Kết luận:** 8.5/9. Gap duy nhất = SSO.

## User's chốt

- Approach **A** — SSO only, keep env-based roles
- GitLab instance = **self-hosted iNET GitLab** (domain confirm sau, VD `gitlab.inet.vn`)
- Bridge (OpenWebUI + Alertmanager) **giữ trust-header** cho `TRUSTED_PROXY_CIDR`

## Design chi tiết Approach A

### Kiến trúc

```
┌──────────────┐                      ┌────────────────┐
│  Browser dev │ 1. GET /login        │  Portal        │
│              │─────────────────────▶│  Next.js       │
└──────────────┘                      └────┬───────────┘
       │                                   │ redirect
       │ 2. GET /oauth/authorize?...       │
       ▼                                   ▼
┌──────────────────┐                  ┌─────────────────┐
│  iNET GitLab     │ 3. login + grant│                 │
│  gitlab.inet.vn  │─────────────────▶│                 │
└──────────────────┘                  │                 │
       │ 4. callback?code=...              ▼            │
       │                              ┌─────────────────┐
       │                              │ Backend         │
       │                              │ NestJS          │
       │                              │                 │
       │  5. POST /oauth/token        │                 │
       │◀─────────────────────────────│                 │
       │  6. GET /api/v4/user         │                 │
       │◀─────────────────────────────│                 │
       │                              │  7. upsert user │
       │                              │  8. Set-Cookie  │
       │                              └────┬────────────┘
       │                                   │
       │  9. redirect / (with cookie)      ▼
       │                              ┌─────────────────┐
       │                              │  Session cookie │
       │                              │  authenticated  │
       │                              └─────────────────┘
```

### Backend changes

**Files create:**
- `backend/src/auth/auth.module.ts`
- `backend/src/auth/auth.controller.ts` — `/api/auth/gitlab/login`, `/api/auth/gitlab/callback`, `/api/auth/logout`
- `backend/src/auth/gitlab-oauth.service.ts` — OAuth2 flow (authorize URL, token exchange, userinfo fetch)
- `backend/src/auth/session.service.ts` — session cookie create/verify/revoke (Redis-backed opaque token, TTL 24h)
- `backend/src/auth/cookie-auth.middleware.ts` — read cookie → set `req.user`

**Files modify:**
- `backend/src/access/trust-user.middleware.ts` — chỉ accept trust-header từ `TRUSTED_PROXY_CIDR` (đã có logic, tighten check)
- `backend/src/access/access.module.ts` — chain: CIDR → **CookieAuth** → ApiKey → TrustUser (fallback, CIDR-gated) → AuthGuard
- `backend/src/app.module.ts` — register AuthModule
- `.env.example` — thêm `GITLAB_SSO_ENABLED`, `GITLAB_OAUTH_APP_ID`, `GITLAB_OAUTH_APP_SECRET`, `GITLAB_OAUTH_REDIRECT_URI`, `SESSION_COOKIE_SECRET`, `SESSION_TTL_HOURS=24`

**Data:**
- Session store = Redis (đã có, không thêm dep). Key `session:{token}` → JSON `{userId, username, email, expiresAt}`. TTL Redis auto-expire.
- KHÔNG thêm table `sessions` — Redis đủ cho MVP.

### Session cookie

- Format: opaque UUID v4 (32-char hex)
- Cookie flags: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=86400`
- Name: `onemcp_session`
- Verify: middleware GET Redis → nếu miss/expired → 401
- Refresh: sliding — mỗi request update TTL (Redis `EXPIRE`)

### Role mapping

Sau OAuth callback:
- Email từ GitLab → username = email prefix (VD `trihd@inet.vn` → `trihd`)
- Upsert `users` (reuse `ensureByEmail` từ Phase 1B)
- Role check env: `if username in ADMIN_USERNAMES → admin; if in MAINTAINER_USERNAMES → maintainer; else contributor`
- Ghi vào Redis session (không đụng DB role columns — giữ nguyên logic Phase 1)

### Portal changes

**Files create:**
- `portal/app/login/page.tsx` — landing với "Sign in with iNET GitLab" button
- `portal/app/logout/page.tsx` — hoặc POST endpoint clear cookie
- `portal/lib/session.ts` — client-side session state helper

**Files modify:**
- `portal/app/layout.tsx` — middleware Next.js check cookie, redirect `/login` nếu chưa auth (trừ `/login`, `/health`)
- `portal/components/nav.tsx` — thay `IdentifyAsDropdown` bằng "Logout" + user email display
- `portal/components/identify-as-dropdown.tsx` — **remove** (hoặc gate sau env flag để rollback)
- `portal/lib/api-client.ts` — bỏ inject `X-Onemcp-User` header (cookie auto-sent qua `credentials: 'same-origin'`)
- `portal/lib/identity.ts` — deprecate `getIdentity()` / `setIdentity()`

### Migration + rollout

1. **Env flag `AUTH_MODE=trust-header` (default)** — deploy code, chưa activate SSO
2. Register GitLab OAuth app (user manual step trên iNET GitLab admin)
3. Populate secrets vào `.env` prod
4. **Flip `AUTH_MODE=gitlab-sso`** — restart backend + portal
5. Rollback plan: set `AUTH_MODE=trust-header` → restart (session cookies invalidated nhưng users retry OK)

### Bridge compatibility

- `X-Onemcp-User` header **VẪN accepted** nhưng chỉ khi request đến từ `TRUSTED_PROXY_CIDR` (VD `10.200.0.0/24` bridge subnet)
- Alertmanager webhook: Bearer token auth (đã có) — không đụng
- OpenWebUI Action + Function: chạy container trong bridge subnet → trust-header OK
- API keys (Phase 1B): giữ nguyên, cho LLM tools + CI

### Security considerations

- **CSRF**: SameSite=Lax + explicit CSRF token cho POST/DELETE (double-submit cookie pattern). Có thể defer nếu tất cả API call qua fetch same-origin (Lax đã đủ).
- **Session hijack**: Secure flag (HTTPS only). Redis session store trong network isolated. Logout invalidate session server-side.
- **Open redirect**: Callback whitelist redirect URI startsWith app URL. State parameter random UUID.
- **Replay**: State param nonce trong Redis 5-min TTL.
- **Rate limit**: `/oauth/callback` throttle 20/min per IP.

## Timeline chi tiết (5-7 ngày dev)

| Day | Task | Deliverable |
|---|---|---|
| 1 | GitLab OAuth app register + design env schema + auth module scaffold | AuthModule empty, env keys documented |
| 2 | GitLab OAuth service (authorize URL builder, token exchange, userinfo fetch) + unit tests | `gitlab-oauth.service.ts` + tests |
| 3 | Session service (Redis) + cookie auth middleware + integration test | Session create/verify/revoke roundtrip |
| 4 | Portal `/login` page + Next.js middleware redirect + `layout.tsx` update | Portal auth flow end-to-end local |
| 5 | Trust-header tighten (CIDR-only) + smoke test bridge tools + rollout env flag `AUTH_MODE` | Bridge integration verified |
| 6 | Deploy staging → E2E test (login, logout, session expiry, refresh) | Staging validation |
| 7 | Deploy prod + monitor 24h + docs update `system-architecture.md` + `docs/sso-guide.md` | Prod cutover |

Buffer 1-2 ngày nếu GitLab OAuth registration hoặc iNET network config có surprise.

## Success criteria

- Portal `/login` → GitLab consent → callback → dashboard (session active)
- Refresh browser → still authenticated 24h
- Logout → cookie cleared → redirect `/login`
- Portal API calls không cần `X-Onemcp-User` header (cookie auto-sent)
- Bridge (OpenWebUI submit, Alertmanager webhook) vẫn hoạt động không đổi
- `AUTH_MODE=trust-header` rollback ≤ 5 phút restart
- Zero regression: MCP tools, API keys, artifact CRUD, search
- Audit log ghi session_id + user_id per request (privacy: KHÔNG log Bearer token / cookie value)

## Risks

| Risk | Mitigation |
|---|---|
| iNET GitLab OAuth API khác GitLab.com | Test staging trước; discovery URL configurable |
| Cookie SameSite issue cross-origin (nếu portal + backend khác subdomain) | Chốt: cùng domain qua nginx proxy (đã có), tránh cross-origin |
| Session Redis mất data khi restart | `appendonly yes` (đã có), sessions sẽ persist |
| User quên logout, session steal | 24h TTL + `Secure` flag; option add "sign out all devices" sau |
| Email không match GitLab primary email của user | Sync GitLab `email` (verified) + fallback `commit_email` |
| GitLab OAuth app credentials leak | Store `.env` prod chỉ, không commit; secret rotation quy trình |

## Non-goals (chốt cứng)

- ❌ SSO group → role sync (Approach B)
- ❌ Admin UI role assignment (Approach C)
- ❌ iNET SSO IdP (làm sau, cần infra iNET-side)
- ❌ Multi-factor auth (GitLab đã handle MFA của họ)
- ❌ OIDC discovery auto (hardcode endpoints GitLab OAuth2)
- ❌ Remove API keys (Phase 1B) — vẫn cần cho LLM tools

## Open questions

1. **iNET GitLab domain chính xác?** — `gitlab.inet.vn`? Cần confirm để register OAuth app
2. **Callback URL prod?** — `https://onemcp.inet.vn/api/auth/gitlab/callback`? Hay dùng IP `https://10.200.0.44/api/auth/gitlab/callback`? Impact SameSite + Secure
3. **Emergency backdoor?** — Nếu SSO down, có cần env flag flip về trust-header không? Recommend: có (AUTH_MODE toggle đã bao gồm)
4. **Session TTL** — 24h hợp lý? Hay 8h workday? Recommend 24h + sliding refresh
5. **User confirm GitLab OAuth app đã có chưa?** — Nếu chưa, user + iNET admin cần register trước

## Next step

Nếu user approve → invoke `/ck:plan` với context brainstorm này để tạo detailed implementation plan.
