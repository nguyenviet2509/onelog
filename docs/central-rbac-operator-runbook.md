# Central RBAC — Operator Runbook

Guide cho Central admin operators (non-dev) quản lý apps, roles, grants trong hệ thống.

## Central Operator Responsibilities

**Current operators** (per Migration 019 bootstrap):
- `kienvt@inet.vn` (Zitadel sub: `389119521513799683`)
- `vietnt@inet.vn` (Zitadel sub: `389119343390097411`)

**Grants role**: `central.operator` (source=system, không edit qua UI).

### Powers
- Grant/revoke `superadmin` role cho bất kỳ app nào (bypass can_grant check)
- Emergency revoke user grants (bất kỳ app)
- Audit log review (privileged view)
- Configure central.operator seed via `019-bootstrap-operators.ts`

### Restrictions
- **Không được grant `central.operator` cho ai khác trừ khi cả 2 operator đồng ý (dual-control)**
- **Không edit `rbac.roles WHERE key='central.operator'` (source=system, migration managed)**
- Audit log tất cả actions với `context.central_operator_bypass: true` flag

## Workflow: Register new app

### Via Central Admin UI

1. Login `/admin` với JWT có `rbac.admin` role
2. Navigate `/apps/new`
3. Fill form:
   - **Name**: Human-readable, VD "OneMCP Portal"
   - **Slug**: kebab-case, 3-32 chars, unique (VD `onemcp`, `helpdesk`)
   - **Callback URLs**: HTTPS OIDC callbacks
   - **Manifest URL**: HTTPS (SSRF-guarded, no private IPs)
   - **Client type**: web / spa / native
   - **Skip default roles**: unchecked (default — wizard tạo 4 role hierarchy)
4. Submit → response include:
   - `zitadel_project_id`
   - `client_id`
   - `client_secret` (**ONE-TIME reveal — store trong vault ngay**)

### Verify
```bash
# Check app trong DB
psql -c "SELECT slug, name, client_type FROM rbac.apps WHERE slug='<slug>';"

# Check 4 default roles created
psql -c "SELECT key, parent_key, can_grant FROM rbac.roles WHERE app_id=(SELECT id FROM rbac.apps WHERE slug='<slug>') ORDER BY key;"
```

Expected: 4 roles `viewer/member/admin/superadmin` với hierarchy chain.

## Workflow: Sync + apply manifest

### First sync (new app)

```bash
# 1. Verify manifest URL accessible
curl https://<app-domain>/.well-known/rbac-permissions.json | jq .

# 2. Trigger sync (Central fetches + validates)
curl -X POST https://rbacnb.000nethost.com/v1/admin/apps/<id>/sync-manifest \
  -H "Authorization: Bearer <admin-JWT>"

# Response: {sha256, etag, diff: {items[], counts}}
```

### Review diff

Actions:
- `add` — new permission trong manifest, không có trong DB. Auto-approve safe.
- `update-desc` — description changed. Auto-approve safe.
- `explicit-deprecate` — manifest declares `status: soft-deleted`. Auto-approve safe.
- `implicit-deprecate` — permission trong DB, missing trong manifest. **Review kỹ** — có thể là accidental removal.

### Apply diff

```bash
curl -X POST https://rbacnb.000nethost.com/v1/admin/apps/<id>/apply-manifest-diff \
  -H "Authorization: Bearer <admin-JWT>" \
  -d '{
    "manifest_sha256": "<from-sync>",
    "approved_items": [
      {"action": "add", "id": "<perm-id>"},
      {"action": "update-desc", "id": "<perm-id>"}
      // Omit implicit-deprecate items nếu chưa muốn deprecate
    ]
  }'
```

## Workflow: Grant/revoke user role

### Grant qua Central Admin UI

1. Navigate `/users/:sub/grants`
2. Click "Add grant" → select app + role + tenant_id (optional)
3. Submit → outbox sync Zitadel + audit log

### Grant qua API (v2)

```bash
# Grant qlts.admin cho user (global)
curl -X POST https://rbacnb.000nethost.com/v2/apps/qlts/grants \
  -H "Authorization: Bearer <admin-JWT>" \
  -d '{
    "user_sub": "389119521513799683",
    "role_key": "qlts.admin",
    "tenant_id": null
  }'

# Grant tenant-scoped
curl -X POST .../grants -d '{
  "user_sub": "...",
  "role_key": "onemcp.member",
  "tenant_id": "dept-cntt"
}'
```

### Revoke qua API (v2)

```bash
# Find grant_id first
psql -c "SELECT id FROM rbac.user_grants WHERE user_sub='<sub>' AND role_key='<key>';"

# Revoke (triggers notify_app_revoke → app xóa session ngay)
curl -X DELETE https://rbacnb.000nethost.com/v2/apps/qlts/grants/<grant-id> \
  -H "Authorization: Bearer <admin-JWT>"
```

## Workflow: Emergency revoke (Central operator only)

Central operator bypass can_grant check → có thể revoke bất kỳ grant:

```bash
# Bypass authorization check qua central.operator bypass (auto-detected)
curl -X DELETE .../grants/<grant-id> -H "Authorization: Bearer <operator-JWT>"
```

Audit log will show `context.central_operator_bypass: true`.

## Workflow: Handle pending_cleanups

Pending cleanup = orphan Zitadel projects (AddOIDCApp failed sau AddProject success).

```bash
# List pending cleanups
psql -c "SELECT id, zitadel_project_id, reason, created_at FROM rbac.pending_cleanups WHERE resolved_at IS NULL;"

# Resolve via reclaim (register app với same name)
# OR manually delete Zitadel project + mark resolved
psql -c "UPDATE rbac.pending_cleanups SET resolved_at=now() WHERE id='<id>';"
```

## Workflow: Read audit log

### Recent activity

```bash
psql -c "
SELECT ts, actor_id, action, target_type, target_id, app_id
FROM rbac.audit_log
ORDER BY ts DESC LIMIT 50;"
```

### Filter by action

```bash
# Grants activity
psql -c "SELECT ts, actor_id, after_state->>'role_key', after_state->>'user_sub'
FROM rbac.audit_log
WHERE action LIKE 'grant.%'
ORDER BY ts DESC LIMIT 20;"

# Denied delegation attempts
psql -c "SELECT ts, actor_id, after_state->>'reason', after_state->>'target_role_key'
FROM rbac.audit_log
WHERE action = 'grant.assign.denied'
ORDER BY ts DESC LIMIT 20;"
```

### Verify hash chain integrity

```bash
psql -c "SELECT rbac.verify_audit_chain_integrity();"
# Expected: null (chain valid). Non-null = tamper detected (INCIDENT).
```

## Health monitoring

### Check central-rbac backend

```bash
curl https://rbacnb.000nethost.com/v1/health | jq '.status, .checks, .v2'
```

Expected healthy response:
```json
{
  "status": "ok",
  "checks": {"db_writer": "ok", "db_auditor": "ok", "redis": "ok"},
  "v2": {
    "migration": 19,
    "features": {"v2_resolve": true, "delegation": true, ...},
    "epoch_trigger_active": true
  }
}
```

### Grafana alerts (recommended)

- `SELECT COUNT(*) FROM rbac.user_grants WHERE role_key='central.operator'` > 2 → INCIDENT (unauthorized operator grant)
- `SELECT COUNT(*) FROM rbac.outbox_events WHERE status='dead'` > 10 → INCIDENT (Zitadel sync failing)
- 4xx spike on `/v2/resolve` → INCIDENT (X-Rbac-Token compromise?)

## Common troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Wizard 409 "orphan project found" | Previous AddOIDCApp failed | Reclaim: `POST /v1/admin/apps` với pending_cleanup_id, hoặc manually delete Zitadel project |
| Sync-manifest 400 "manifest_url unreachable" | SSRF check reject / DNS fail | Verify manifest tại `.well-known/` HTTPS accessible, no private IP |
| Grant assign 403 "no_role_can_grant_target" | Grantor không có role với can_grant chứa target | Central operator bypass hoặc grant grantor higher role trước |
| Revoke silent (user vẫn access) | notify_app_revoke fail hoặc app không support webhook | Check `rbac.outbox_events WHERE type='notify_app_revoke'` — retry manually |
| /v2/resolve returns 401 | X-Rbac-Token mismatch | Verify token đúng vs Central deployment env |
| /v2/resolve returns empty roles | User không có grant, HOẶC wrong tenant_id | Check `SELECT * FROM rbac.user_grants WHERE user_sub=...` |

## Deploy paths (know your infrastructure)

```
/opt/onelog/central-rbac/            → git checkout (sync source)
/opt/central-rbac/                   → prod deployment dir (contains .env, docker-compose.prod.yml)
```

**Deploy workflow**:
```bash
# 1. Local commit + push
git push origin master

# 2. SSH VPS
ssh authway-vps
cd /opt/onelog && git pull origin master

# 3. Sync source (excludes .env, node_modules)
rsync -av --delete --exclude=.env --exclude=node_modules \
  /opt/onelog/central-rbac/ /opt/central-rbac/

# 4. Rebuild central-rbac only (giữ postgres/redis/ui)
cd /opt/central-rbac && docker compose -f docker-compose.prod.yml up -d --build central-rbac

# 5. Verify
curl https://rbacnb.000nethost.com/v1/health
```

**IMPORTANT — Traefik label reload**:
- Docker label changes require `--force-recreate` — `up -d` alone không reload labels
- Nếu update Traefik routing (VD add `/v3/*` prefix), phải `--force-recreate`

## Related

- Migration 019 SQL: [central-rbac/src/db/migrations/019_rbac_v2_foundation.sql](../central-rbac/src/db/migrations/019_rbac_v2_foundation.sql)
- Bootstrap operators: [central-rbac/scripts/019-bootstrap-operators.ts](../central-rbac/scripts/019-bootstrap-operators.ts)
- App onboarding: [central-rbac-app-onboarding.md](central-rbac-app-onboarding.md)
- Migration v1→v2: [central-rbac-manifest-v2-migration.md](central-rbac-manifest-v2-migration.md)
