# central-rbac-ui

Minimal React admin portal for Central RBAC — Users + Assignments management.
Phase 4 of plan `260821-1644-central-rbac-single-pane`.

## Dev quickstart

```bash
cp .env.example .env.local
# Fill in VITE_ZITADEL_CLIENT_ID with your Zitadel app client_id
npm install
npm run dev
# Opens at http://localhost:5173 (proxies /v1 → localhost:3000)
```

## Build

```bash
npm run build   # outputs to dist/
npm run preview # local preview of production build
```

## Docker

```bash
docker build \
  --build-arg VITE_ZITADEL_ISSUER=http://10.200.0.125:8080 \
  --build-arg VITE_ZITADEL_CLIENT_ID=central-rbac-ui \
  --build-arg VITE_ZITADEL_REDIRECT_URI=http://10.200.0.125:8082/callback \
  --build-arg VITE_REVIEW_MODE=true \
  -t central-rbac-ui .

docker run -p 8082:80 central-rbac-ui
```

## Routes

| Path | Description |
|------|-------------|
| `/login` | Login via Zitadel OIDC |
| `/callback` | OIDC redirect callback |
| `/users` | Users list + search |
| `/users/:id` | User detail drawer overlay |

## Phase reference

`plans/260821-1644-central-rbac-single-pane/phase-04-ui-users-assignments.md`
