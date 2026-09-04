# Phase 04 UI — Users + Assignments: Implementation Report

**Date:** 2026-08-25
**Phase file:** `plans/260821-1644-central-rbac-single-pane/phase-04-ui-users-assignments.md`

---

## Status

- `tsc -b --noEmit`: 0 errors
- `npm run build`: SUCCESS — gzip 181.85 KB (under 400 KB limit)
- `npm run lint`: 0 errors, 2 warnings (non-blocking, see below)
- Docker image: builds (multi-stage node:20-alpine → nginx:1.27-alpine)

---

## Files Created

| File | LOC |
|------|-----|
| `src/main.tsx` | 16 |
| `src/App.tsx` | 31 |
| `src/router.tsx` | 39 |
| `src/index.css` | 38 |
| `src/lib/utils.ts` | 49 |
| `src/lib/types.ts` | 62 |
| `src/lib/toast-bus.ts` | 20 |
| `src/auth/oidc-client.ts` | 28 |
| `src/auth/auth-context.tsx` | 22 |
| `src/auth/protected-route.tsx` | 41 |
| `src/hooks/use-permissions.ts` | 23 |
| `src/hooks/use-users-query.ts` | 22 |
| `src/hooks/use-assignments-query.ts` | 41 |
| `src/hooks/use-bulk-grant.ts` | 47 |
| `src/api/client.ts` | 35 |
| `src/api/users.ts` | 22 |
| `src/api/assignments.ts` | 33 |
| `src/api/roles.ts` | 11 |
| `src/api/projects.ts` | 27 |
| `src/components/ui/button.tsx` | 43 |
| `src/components/ui/dialog.tsx` | 45 |
| `src/components/ui/drawer.tsx` | 47 |
| `src/components/ui/input.tsx` | 22 |
| `src/components/ui/select.tsx` | 24 |
| `src/components/ui/badge.tsx` | 30 |
| `src/components/ui/toast-provider.tsx` | 61 |
| `src/components/layout/sidebar.tsx` | 55 |
| `src/components/layout/header.tsx` | 35 |
| `src/components/layout/app-shell.tsx` | 29 |
| `src/components/data-table.tsx` | 74 |
| `src/components/confirm-dialog.tsx` | 82 |
| `src/components/error-boundary.tsx` | 46 |
| `src/pages/login/login-page.tsx` | 51 |
| `src/pages/login/callback-page.tsx` | 38 |
| `src/pages/users/users-list-page.tsx` | 158 |
| `src/pages/users/user-detail-drawer.tsx` | 140 |
| `src/pages/users/grant-dialog.tsx` | 100 |
| `src/pages/users/revoke-dialog.tsx` | 48 |
| `src/pages/users/bulk-assign-dialog.tsx` | 119 |
| `Dockerfile` | multi-stage |
| `nginx.conf` | SPA fallback + CSP headers |
| `.env.example` | documented all VITE_* vars |
| `README.md` | < 50 lines |

All files under 200 LOC.

---

## Key decisions

- **@tanstack/react-table v8** — installed v9 first (breaking API change), downgraded to v8.21.3. v8 is stable and matches phase spec API.
- **No shadcn CLI** — installed Radix UI primitives directly + hand-wrote minimal components. Avoids shadcn codegen complexity, results are lighter and fully owned.
- **Native `<select>`** for project/role dropdowns — sufficient for MVP, avoids Radix Select complexity.
- **toast-bus event emitter** — decouples api/client from React context to fire toasts from Axios interceptors without circular deps.
- **debounce uses `any[]`** — TypeScript strict mode requires `any[]` on the generic constraint when callers pass typed functions; documented with eslint-disable comment.
- **DataTable uses `ColumnDef<T, any>`** — `createColumnHelper` returns narrowly typed columns (e.g. `string`), incompatible with `unknown` without cast. `any` here is the correct escape hatch.

---

## Routes delivered

| Path | Component |
|------|-----------|
| `/login` | `LoginPage` — Zitadel OIDC redirect |
| `/callback` | `CallbackPage` — code exchange spinner |
| `/users` | `UsersListPage` — table + search + drawer + bulk |
| `/users/:id` | Same `UsersListPage` (drawer overlay) |
| `/` | Redirect → `/users` |

---

## Env vars (.env.example)

| Var | Review IP | Production |
|-----|-----------|------------|
| `VITE_API_BASE_URL` | `/v1` | `/v1` |
| `VITE_ZITADEL_ISSUER` | `http://10.200.0.125:8080` | `https://zitadel.<domain>` |
| `VITE_ZITADEL_CLIENT_ID` | `central-rbac-ui` | same |
| `VITE_ZITADEL_REDIRECT_URI` | `http://10.200.0.125:8082/callback` | `https://rbac.<domain>/callback` |
| `VITE_REVIEW_MODE` | `true` | `false` |

---

## Lint warnings (non-blocking)

1. `data-table.tsx:22` — React Compiler incompatible library (false positive, no React Compiler in use)
2. `auth-context.tsx:22` — `only-export-components` on re-exported `useAuth` hook — intentional convenience re-export, documented in file

---

## TODOs / follow-ups

1. **`/v1/users` backend endpoint missing** — `api/users.ts` calls `GET /v1/users?q=&limit=` and `GET /v1/users/:id` which are not implemented in `central-rbac` backend yet. UI will show "Không thể tải" error until Phase 5 adds Zitadel user proxy routes.
2. **`/v1/projects` backend endpoint missing** — `api/projects.ts` has graceful fallback to hardcoded `[{ id: 'central-rbac', name: 'Central RBAC' }]` for MVP. Fine for Phase 4.
3. **Zitadel OIDC app registration** — must be done manually in Console: `Projects → central-rbac → Applications → New Web OIDC → redirect URI = http://10.200.0.125:8082/callback`. Enable dev mode for HTTP redirect.
4. **Silent renew iframe** — accepted trade-off for HTTP review mode. Will fail silently on Chrome (blocks cross-origin iframe storage). Token TTL needs to be long enough (≥ 15 min recommended).
5. **CSP `unsafe-inline`** for styles — added for Tailwind v4 which injects styles at runtime. When nonce infra is available, swap to nonce-based approach.
6. **smoke test deferred** — local smoke test requires Zitadel OIDC app registration + running backend. Deferred to Phase 5 deploy.

---

## Unresolved questions

- What is the exact Zitadel `client_id` to put in `.env.local`? (placeholder = `central-rbac-ui` in .env.example)
- Will silent renew be needed for review period or can session token TTL be extended to avoid iframe issues on HTTP?
