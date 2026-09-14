# Central RBAC App Template

Minimal Fastify template dùng `@onelog/central-rbac-client` để protect endpoints qua Central RBAC v2.

**Target**: Clone → rename slug → run → protected endpoint hoạt động trong <30 phút.

## Quickstart

```bash
# 1. Clone + install
cp .env.example .env
# Edit .env: set CENTRAL_URL, APP_SLUG, CENTRAL_RBAC_TOKEN
npm install

# 2. Run
npm run dev

# 3. Test (assumes Central dev up, app đã register)
curl -H "x-user-sub: 389119521513799683" http://localhost:3000/tickets
```

## Files

| File | Purpose |
|---|---|
| `src/app.ts` | Fastify entry, register SDK |
| `src/config.ts` | Env config với zod validation |
| `src/routes/tickets.ts` | Example CRUD với `requirePermission` |
| `manifest/rbac-permissions.json` | Manifest v2: 12 permissions + 4 role hierarchy |
| `.env.example` | Template env config |

## Full onboarding

Xem `docs/central-rbac-app-onboarding.md` cho 5-step register + grant + verify workflow.

## Notes

- Template dùng mock auth (`x-user-sub` header) — replace với @fastify/jwt + Zitadel JWKS verify trong prod.
- `failMode='closed'` là default (safe): Central down → app return 503.
- `failMode='open'` chỉ dev mode — SDK hardcoded reject nếu `NODE_ENV=production`.
