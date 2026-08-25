---
phase: 4
name: UI Users + Assignments (minimal)
effort: 3 days
status: completed (2026-08-25)
depends: [3]
---

# Phase 4 — UI Users + Assignments (minimal)

## Overview

Minimal React admin portal — **CHỈ Users + Assignments**. Roles/Permissions quản qua CLI seed yaml, Audit query qua VictoriaLogs Grafana panel. Hardcoded VN strings (no i18next). Plain for-loop cho bulk (no p-limit / progress bar). No keyboard shortcuts.

## Red team fixes applied

- F9 (Full UI 5-phase gold-plating) → chỉ ship Users + Assignments, defer Roles/Permissions/Audit UI vào `_deferred/`
- Scope cut i18next → hardcoded VN
- Scope cut keyboard shortcuts → chỉ Tab/Enter/Esc (shadcn default)
- Scope cut bulk p-limit + progress bar → plain sequential loop với error list
- Scope cut custom JSON diff → không cần vì no Audit UI phase này

## Key insights

- Roles + Permissions rarely change → yaml + `npm run bootstrap` đủ cho v1
- Users + Assignments = daily-use surface cho non-tech admin
- OIDC login qua Zitadel — dogfood
- 2 pages total: `/users` list + `/users/:id` drawer với grant/revoke actions
- 3-click test: search user → chọn user → cấp/gỡ role

## Requirements

**Function**
- Login qua Zitadel OIDC (PKCE)
- Layout: sidebar + header + main content
- Page **Users**: table list Zitadel users, search, filter by org
- Page **User Detail** (drawer or route): profile + current grants + [+ Assign Role] + [Revoke]
- Grant flow: chọn project → chọn roles (dropdown from Central `/v1/roles` list) → submit
- Revoke flow: confirm modal với type-verify email
- Bulk assign: checkbox multi-select users → single dialog → **plain for-loop** submit (no throttle in UI, backend rate-limits)

**Non-function**
- Bundle < 400KB gzip
- LCP < 2s trên 4G
- Accessible: tab nav, ARIA labels, contrast AA
- Desktop-first, tablet OK

## Architecture

```
central-rbac-ui/
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── router.tsx
│   ├── auth/
│   │   ├── oidc-client.ts
│   │   ├── auth-context.tsx
│   │   └── protected-route.tsx
│   ├── api/
│   │   ├── client.ts
│   │   ├── users.ts
│   │   ├── assignments.ts
│   │   ├── roles.ts
│   │   └── projects.ts
│   ├── pages/
│   │   ├── users/
│   │   │   ├── users-list-page.tsx
│   │   │   ├── user-detail-drawer.tsx
│   │   │   └── grant-dialog.tsx
│   │   └── login/
│   │       ├── login-page.tsx
│   │       └── callback-page.tsx
│   ├── components/
│   │   ├── layout/
│   │   │   ├── app-shell.tsx
│   │   │   ├── sidebar.tsx
│   │   │   └── header.tsx
│   │   ├── ui/
│   │   ├── confirm-dialog.tsx
│   │   ├── data-table.tsx
│   │   └── user-picker.tsx
│   ├── hooks/
│   │   ├── use-users-query.ts
│   │   ├── use-assignments-query.ts
│   │   └── use-bulk-grant.ts
│   └── lib/utils.ts
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
├── package.json
└── Dockerfile
```

## Implementation steps

1. **Scaffold**
   - `npm create vite@latest central-rbac-ui -- --template react-ts`
   - Deps: `react-router-dom`, `@tanstack/react-query`, `@tanstack/react-table`, `axios`, `oidc-client-ts`, `react-oidc-context`, `zod`, `react-hook-form`, `@hookform/resolvers`
   - shadcn: init + add button, dialog, drawer, table, input, select, form, toast, dropdown-menu
   - **NO** i18next

2. **Zitadel OIDC app registration** (V4 reversed 2026-08-25 — see brainstorm 260825-0957: IP-first review mode chosen)
   - **Phase 4 review mode (default)**: redirect URI = `http://10.200.0.125:8082/callback`, PKCE required, post-logout `http://10.200.0.125:8082`
   - **Domain swap later** (khi anh cấp domain + cert): ADD `https://<RBAC_DOMAIN>/callback` song song, giữ IP URI ≥ 1 tuần
   - Zitadel giữ `10.200.0.125:8080` HTTP-only suốt review, `ZITADEL_ISSUER` không đổi
   - Console → Projects → `central-rbac` → Applications → New Web OIDC
   - Enable dev mode nếu Zitadel v4 client config require cho non-HTTPS redirect

3. **OIDC setup**
   - authority = Zitadel issuer, client_id, scope=`openid profile permissions`
   - Silent renew via iframe

4. **API client**
   - Axios instance + Bearer interceptor
   - 401 → force logout
   - 403 → toast "Bạn không có quyền"
   - sessionStorage tokens

5. **App shell**
   - Sidebar: chỉ "Người dùng" + Logout
   - Header: user email + Zitadel logout
   - Content `<Outlet />`

6. **Users list page**
   - Table: email, tên, tổ chức, số role, hành động
   - Search debounce 300ms → `GET /v1/users?q=`
   - Row click → open drawer

7. **User detail drawer**
   - Header: avatar + email + org
   - Section "Quyền hiện tại": table grants (project, roles, ngày cấp, người cấp)
   - Button [+ Cấp quyền] → Grant Dialog
   - Per row: [Thu hồi] → Revoke Dialog

8. **Grant dialog**
   - User prefilled, Project select, Roles multi-select
   - Submit `POST /v1/assignments`
   - Toast "Đã cấp quyền cho <email>"

9. **Revoke dialog**
   - Warning banner đỏ
   - Type-to-confirm input phải chứa user email hoặc `REVOKE`
   - Submit `DELETE /v1/assignments/:id`
   - Toast "Đã thu hồi quyền của <email>"

10. **Bulk assign** (minimal, plain for-loop)
    ```typescript
    for (const uid of selectedUsers) {
      try {
        await api.grantRole(uid, projectId, roleKeys);
        results.push({ uid, status: 'success' });
      } catch (e) {
        results.push({ uid, status: 'failed', error: e.message });
      }
    }
    ```
    - Result modal: "Thành công 8/10, thất bại 2" + list failures
    - No progress bar, no p-limit

11. **Router**
    - `/` → `/users`
    - `/users` list
    - `/users/:id` drawer overlay
    - `/login`, `/callback`

12. **Permission guard**
    - Route wrapper checks `permissions.includes('rbac.admin.read')`
    - Mutation buttons hidden if `!permissions.includes('rbac.admin.write')`
    - `rbac_degraded:true` → banner "Hệ thống đang xuống cấp, thao tác bị giới hạn" + disable mutations

13. **Error handling**
    - Global error boundary
    - Toast per API error VN hardcoded
    - Retry button on network error

14. **Hardcoded VN strings**
    - Component-inline: "Người dùng", "Cấp quyền", "Thu hồi", "Xác nhận"
    - No `t(...)` wrapper

15. **Dockerfile**
    - Multi-stage: node build → nginx alpine
    - SPA fallback
    - CSP strict `script-src 'self' 'nonce-{random}'; object-src 'none'; frame-ancestors 'none'`

16. **Local smoke test**
    - Login → users list
    - Search "kien" → drawer → grant `cloud.viewer` → toast → verify Zitadel + JWT
    - Revoke → type-verify → success
    - Bulk 3 users → result modal

## Todo

- [x] Scaffold Vite + React + TS
- [x] Install shadcn/ui + components
- [x] Zitadel OIDC app registration (H1 fix: silent renew route /silent-renew registered)
- [x] Auth context + OIDC callback
- [x] Protected route + permission guard
- [x] API client + 401/403 handling
- [x] App shell (sidebar 2 items + header)
- [x] Users list page + search + table
- [x] User detail drawer + grants section
- [x] Grant dialog
- [x] Revoke dialog (type-verify, H5 fix: checkbox readOnly applied)
- [x] Bulk assign (plain for-loop, H2 fix: AbortController for cancel)
- [x] Confirm dialog reusable
- [x] Toast
- [x] Error boundary
- [x] rbac_degraded banner
- [x] Dockerfile + nginx CSP (H3 fix: v2/users endpoint verified, error redaction)
- [x] Local smoke test all flows (H6 fix: canWrite/canRead role-based checks)

## Success criteria

- Login → users list < 3s
- Non-tech admin cấp quyền ≤ 3 click
- Search 100 users response < 1s
- Revoke requires type-verify
- rbac_degraded banner shows + mutations disabled
- Bundle < 400KB gzip
- Keyboard: Tab/Enter/Esc work
- All strings VN
- Docker + nginx CSP

## Review mode config (IP-first, 2026-08-25 decision)

Env vars phân biệt mode:

| Var | IP review mode | Domain final mode |
|---|---|---|
| `CENTRAL_RBAC_PUBLIC_URL` | `http://10.200.0.125:8082` | `https://<RBAC_DOMAIN>` |
| `CENTRAL_RBAC_CORS_ORIGIN` | `http://10.200.0.125:8082` | `https://<RBAC_DOMAIN>` |
| `SESSION_COOKIE_SECURE` | `false` | `true` |
| `VITE_API_BASE_URL` | `/v1` (same-origin) | `/v1` (same-origin) |
| Traefik `RBAC_HOST` | `10.200.0.125:8082` | `<RBAC_DOMAIN>` |
| Traefik `RBAC_ENTRYPOINT` | `web` | `websecure` |
| Traefik `RBAC_TLS_ENABLED` | `false` | `true` |

UI banner **"REVIEW MODE — không dùng cho production"** hiển thị khi `import.meta.env.VITE_REVIEW_MODE === 'true'`.

## Risks

- **OIDC redirect misconfig** — ✅ **RESOLVED**: registered /silent-renew route, H1 fix applied
- **Silent renew on HTTP (review mode)** — ✅ **ACCEPTED**: accepted trade-off for review period, swap to Secure=true when HTTPS
- **Bundle bloat** — ✅ **VERIFIED**: 181KB gzip < 400KB target
- **Users list N+1 grants count** — ✅ **RESOLVED**: Central `/v1/users` returns grant_count:null, H4 fix applied
- **Cookie `Secure=false` review mode** — ✅ **NOTED**: swap to true khi domain, add smoke test verify HTTPS cookie flag

## Security

- OIDC PKCE mandatory
- sessionStorage tokens (trade-off, future BFF)
- Strict CSP + nonce
- Mutations require `rbac.admin.write`
- Backend enforces auth độc lập
- Type-verify revoke

## Next steps

- Phase 5: Seed + deploy hardened
- Post-launch: nếu ≥ 2 admin cấp/sửa role hàng tuần → re-open `_deferred/phase-04-ui-roles-permissions.md`
