# Central RBAC — App Onboarding Guide

Quy trình 5 bước để tích hợp app mới với Central RBAC v2. Target: dev mới clone template → protected endpoint hoạt động end-to-end trong <4h.

## Prerequisites

- Central RBAC dev instance available (default `https://rbacnb.000nethost.com` prod, hoặc dev instance)
- Access to Central admin UI để register app (JWT với `rbac.admin` role)
- Zitadel org access để get user subs cho testing
- Node 20+ + npm/pnpm

## Step 1 — Scaffold app từ template

```bash
git clone <template-repo> my-app
cd my-app
cp .env.example .env
```

Edit `.env`:
```
CENTRAL_URL=https://rbacnb.000nethost.com
APP_SLUG=my-app                              # kebab-case, 3-32 chars, must match manifest.service
CENTRAL_RBAC_TOKEN=<fetch-from-vault>        # KHÔNG hardcode, lấy từ Central deployment
PORT=3000
```

Rename tất cả reference `template-app` → `my-app`:
- `manifest/rbac-permissions.json` — `service: "my-app"`, permission ids `my-app:...`, role keys `my-app.viewer/member/admin/superadmin`
- `src/routes/tickets.ts` — permission keys reference `my-app:tickets.list` etc.

Install:
```bash
npm install
```

## Step 2 — Publish manifest tại `.well-known`

Manifest phải HTTPS-accessible tại URL trong `manifest_url` field khi register.

**Dev**: Serve local static file với ngrok hoặc cloudflared:
```bash
# Terminal 1: serve manifest
python3 -m http.server 8080 --directory manifest

# Terminal 2: tunnel
cloudflared tunnel --url http://localhost:8080
# → Note the https URL, VD https://abc.trycloudflare.com/rbac-permissions.json
```

**Prod**: Serve manifest từ app itself qua `/.well-known/rbac-permissions.json` static route.

Verify:
```bash
curl https://<your-tunnel>/rbac-permissions.json | jq .schema
# Expected: "2"
```

## Step 3 — Register app via Central wizard

**Via Central Admin UI**: navigate `/apps/new` → fill form:
- Name: `My App`
- Slug: `my-app`
- Callback URLs: `https://my-app.example.com/oidc/callback` (Zitadel OIDC)
- Manifest URL: `https://<your-tunnel>/rbac-permissions.json`
- Client type: `web` | `spa` | `native`
- Skip default roles: `false` (unchecked — wizard sẽ tạo 4 role hierarchy)

**Via API**:
```bash
curl -X POST https://rbacnb.000nethost.com/v1/admin/apps \
  -H "Authorization: Bearer <admin-JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My App",
    "slug": "my-app",
    "callback_urls": ["https://my-app.example.com/oidc/callback"],
    "manifest_url": "https://<your-tunnel>/rbac-permissions.json",
    "client_type": "web"
  }'
```

Response `201`:
```json
{
  "id": "uuid",
  "slug": "my-app",
  "zitadel_project_id": "...",
  "client_id": "...",
  "client_secret": "<one-time-reveal-store-in-vault>"
}
```

Wizard tự động tạo 4 default roles với hierarchy:
- `my-app.viewer` (root)
- `my-app.member` (parent: viewer)
- `my-app.admin` (parent: member, can_grant: [member, viewer])
- `my-app.superadmin` (parent: admin, can_grant: [admin, member, viewer])

## Step 4 — Sync + apply manifest

Sau register, sync manifest để wire permissions ↔ roles:

```bash
# Fetch + validate manifest, compute diff
curl -X POST https://rbacnb.000nethost.com/v1/admin/apps/<app-id>/sync-manifest \
  -H "Authorization: Bearer <admin-JWT>"

# Response includes: diff.items[] với action=add/update-desc/etc + manifest_sha256

# Apply diff (approve tất cả)
curl -X POST https://rbacnb.000nethost.com/v1/admin/apps/<app-id>/apply-manifest-diff \
  -H "Authorization: Bearer <admin-JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "manifest_sha256": "<from-sync-response>",
    "approved_items": [{"action": "add", "id": "my-app:tickets.list"}, ...]
  }'
```

Verify permissions applied:
```bash
psql -h <db-host> -U rbac_reader central_rbac \
  -c "SELECT key FROM rbac.permissions WHERE key LIKE 'my-app:%' AND deprecated_at IS NULL ORDER BY key;"
```

## Step 5 — Grant test user + verify enforcement

Grant test user (Zitadel sub) role `my-app.admin`:

**Via Central UI**: `/users/:sub/grants` → add grant → app=`my-app`, role=`my-app.admin`, tenant_id=NULL (global).

**Via API**:
```bash
curl -X POST https://rbacnb.000nethost.com/v2/apps/my-app/grants \
  -H "Authorization: Bearer <admin-JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "user_sub": "389119521513799683",
    "role_key": "my-app.admin",
    "tenant_id": null
  }'
```

Start app:
```bash
npm run dev
```

Test protected endpoint:
```bash
# Should return 200 với ticket list (empty)
curl -H "x-user-sub: 389119521513799683" http://localhost:3000/tickets

# Should return 200 với ticket created
curl -H "x-user-sub: 389119521513799683" \
  -H "Content-Type: application/json" \
  -X POST -d '{"title": "Test", "dept": "cntt"}' \
  http://localhost:3000/tickets

# Grant same user only `my-app.viewer`, retry POST → should return 403 Forbidden
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 401 "missing user_sub" | Mock auth hook không set jwtClaims | Verify `x-user-sub` header đúng (dev) hoặc JWT plugin registered (prod) |
| 403 "permission not in resolved set" | User không có grant / role không map permission | Check `rbac.user_grants` + `rbac.role_permissions` tables |
| 503 "Central unreachable" | Circuit breaker open OR CENTRAL_URL sai | Verify Central health `/v1/health`, check CENTRAL_RBAC_TOKEN correct |
| RBAC_MANIFEST_MISMATCH error | Central return X-Api-Version=1 nhưng SDK expect 2 | Central chưa deploy Phase 3 code (upgrade Central) |
| Empty resolve response (không lỗi) | User không có bất kỳ grant nào trong app | Grant qua Step 5 |
| SDK log SDK_FAILOPEN_BYPASS | Circuit open + failMode=open (dev only) | Chỉ dev — prod hardcoded reject config này |

## Next steps

- **Wire real Zitadel JWT verify**: replace mock header với `@fastify/jwt` + JWKS URL
- **Set up monitoring**: expose `/health` + Prometheus metrics
- **Read operator runbook**: `docs/central-rbac-operator-runbook.md` cho grant management workflow
- **Read migration guide** (nếu upgrading from v1): `docs/central-rbac-manifest-v2-migration.md`

## Related

- Plan: [plans/260910-1334-central-rbac-v2-refactor/](../plans/260910-1334-central-rbac-v2-refactor/)
- SDK: [central-rbac-client/](../central-rbac-client/)
- Template: [central-rbac-app-template/](../central-rbac-app-template/)
