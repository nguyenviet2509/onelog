# Central RBAC — Manifest v1 → v2 Migration Guide

Cho apps hiện có (qlts, onemcp) muốn upgrade từ manifest v1 flat → v2 hierarchy + delegation + tenant scope.

**Migration là VOLUNTARY, không forced**. V1 endpoints tồn tại 12+6 tháng transition + read-only. Cook migration khi app cần feature v2:
- Delegation (app admin grant subset qua can_grant thay Central admin)
- Tenant scope (per-dept, per-org grants)
- SDK Node.js với circuit breaker + epoch poll

## Timeline

| Date | Milestone |
|---|---|
| 2026-09-10 | V2 launch, V1 và V2 song song |
| 2027-09-10 | V1 endpoints deprecated warning (`Deprecation: date="2028-03-10"` header) |
| 2028-03-10 | V1 endpoints return 410 Gone. Migration 019 vẫn giữ cột NULL fallback. |

## What changes

### Manifest schema

**v1 (flat)**:
```json
{
  "schema": "1",
  "service": "qlts",
  "version": "1.0.0",
  "permissions": [...],
  "default_roles": [
    { "key": "qlts.admin", "description": "...", "permissions": [...] }
  ]
}
```

**v2 (hierarchy + delegation + tenant)**:
```json
{
  "schema": "2",
  "service": "qlts",
  "version": "2.0.0",
  "tenant_aware": true,
  "tenant_lookup_url": "https://qlts.example.com/api/tenants",
  "permissions": [...],
  "default_roles": [
    { "key": "qlts.viewer",   "parent_key": null,          "permissions": [...], "can_grant": [] },
    { "key": "qlts.admin",    "parent_key": "qlts.viewer", "permissions": [...], "can_grant": ["qlts.viewer"] }
  ]
}
```

**Additive changes** (nếu KHÔNG dùng feature mới):
- `schema: "2"` field (thay "1")
- `parent_key: null` mỗi role (backward-compat = flat)
- `can_grant: []` mỗi role (empty = không delegation)
- `tenant_aware: false` optional (defaults false)

### Grant model

**v1**: Zitadel là source of truth. Central resolve gọi Zitadel Mgmt API.
**v2**: Central `rbac.user_grants` là source of truth. Zitadel outbox sync async.

**Impact**: V1 apps giữ nguyên (v1 endpoints vẫn query Zitadel). V2 apps dùng `/v2/apps/:slug/grants` → Central-side grants + outbox sync Zitadel.

### API surface

| v1 | v2 | Notes |
|---|---|---|
| `POST /v1/resolve {roles[]}` | `POST /v2/resolve {user_sub, app_slug, tenant_id?}` | v2 fetches grants + expands hierarchy |
| `GET /v1/health` | `GET /v1/health` (extended với nested `v2` key) | Backward-compat top-level `.status` unchanged |
| Global `metadata.resolve_epoch` | Per-app `apps.permission_epoch` | Dual-bump trigger — cả 2 cùng update |
| `/v1/assignments` (admin only) | `/v2/apps/:slug/grants` (delegation) | v2 enforce can_grant qua wizard/manifest |
| N/A | `GET /v2/epoch/:app_slug` | New endpoint cho SDK poll |

## Migration steps

### Option A — In-place upgrade (recommended cho small apps)

1. **Update manifest** — thêm `schema: "2"`, `parent_key: null` mỗi role, `can_grant: []`:
   ```bash
   # jq script để convert v1 → v2 (additive-only)
   jq '.schema = "2" | .default_roles |= map(. + {parent_key: null, can_grant: []})' \
     manifest-v1.json > manifest-v2.json
   ```

2. **Test in staging** — publish manifest v2, sync qua Central, verify:
   ```bash
   curl -X POST https://rbacnb.000nethost.com/v1/admin/apps/:id/sync-manifest -H "Authorization: Bearer <admin>"
   # Verify: response `diff.items[]` empty (nothing changed vì additive-only)
   ```

3. **Enable hierarchy** — gradually add `parent_key` để build chain:
   ```json
   { "key": "qlts.admin", "parent_key": "qlts.editor", ... }
   ```

4. **Enable delegation** — set `can_grant` mỗi role:
   ```json
   { "key": "qlts.admin", "can_grant": ["qlts.editor", "qlts.viewer"], ... }
   ```

5. **Enable tenant scope** (nếu cần) — `tenant_aware: true` + optional `tenant_lookup_url`.

6. **Switch client code** — upgrade SDK từ raw fetch → `@onelog/central-rbac-client`:
   ```typescript
   // Before (v1)
   const res = await fetch('/v1/resolve', { body: JSON.stringify({ roles: userRoles }) });

   // After (v2)
   const client = new CentralRbacClient({ centralUrl, appSlug, centralRbacToken });
   const result = await client.resolve(userSub, tenantId);
   ```

### Option B — Parallel run (safer cho critical apps)

Cook v2 song song v1 cho staged rollout:
- Traffic split 90/10 → 50/50 → 10/90 (v1/v2)
- Monitor via `X-Api-Version` response header
- Rollback = flip config

## Rollback plan

**Nếu v2 issues xuất hiện**:

1. **Immediate**: revert client code về v1 API calls (SDK config `centralUrl` unchanged, chỉ đổi endpoint):
   ```typescript
   // Rollback quick fix — không dùng SDK
   const res = await fetch('/v1/resolve', {...});
   ```

2. **Manifest revert** — publish manifest v1 tại `.well-known` URL:
   ```bash
   # Revert manifest URL (Central sẽ pick up next sync)
   cp manifest-v1-backup.json /www/root/rbac-permissions.json
   curl -X POST .../sync-manifest -H "Authorization: Bearer <admin>"
   ```

3. **DB rollback** (extreme case only) — run Migration 019 rollback:
   ```bash
   # WARNING: Xóa rbac.user_grants → mất v2 grants
   psql -f central-rbac/src/db/migrations/019_rollback.sql
   ```
   V1 grants trong Zitadel KHÔNG bị ảnh hưởng (Zitadel là source of truth v1).

## Zitadel side effects

**Outbox worker sync v2 grants với hierarchy expand**. Điểm quan trọng:

- **V1 backward-compat guard** (P0 fix): outbox worker chỉ expand nếu `role.parent_key IS NOT NULL`. Existing v1 grants (qlts.admin không có parent) → sync self-only → **Zitadel Console state UNCHANGED**.
- **V2 grants với hierarchy** → sync full expanded list. Ex: grant `qlts.admin` (parent=editor.parent=viewer) → Zitadel receives `[qlts.admin, qlts.editor, qlts.viewer]`.
- **Admin Console manual edits sẽ bị revert** next sync. Doc cho ops team.

## Test checklist

- [ ] Manifest v2 parse OK (validate qua `POST /v1/admin/apps/:id/validate-manifest` dry-run — pending Phase 2b)
- [ ] Sync + apply completes without errors
- [ ] `/v2/resolve` return same permissions as `/v1/resolve` cho same user/roles
- [ ] Grant + revoke qua `/v2/apps/:slug/grants` triggers `notify_app_revoke` (parity v1)
- [ ] Delegation: app admin (không phải Central admin) grant sub-role successfully
- [ ] Cross-tenant grant: user với grant tenant=A không truy cập được resource tenant=B
- [ ] SDK `checkPermission()` returns đúng result (bao gồm inherited permissions)
- [ ] Epoch bump khi grant change (test: `GET /v2/epoch/:slug` before/after)

## Common issues

| Symptom | Cause | Fix |
|---|---|---|
| Sync returns 400 "cycle detected" | parent_key chain có cycle | Fix manifest, verify với validator-v2 |
| Sync returns 400 "cannot grant descendant" | can_grant target là descendant | Delegation grant DOWN không UP (higher role grants lower) |
| /v2/resolve returns empty roles | User có v1 grant nhưng chưa migrate v2 user_grants | Backfill: INSERT INTO rbac.user_grants từ Zitadel user_grants (manual script) |
| Zitadel Console shows extra roles per user | Hierarchy expand active for v2 | Expected — v2 inherits chain. Doc cho ops. |
| App v1 code break sau migrate | Response shape khác (v2 có `epoch` field) | Add version dispatch: nếu response has `epoch` → v2 path |

## Related

- V2 spec: [plans/reports/brainstorm-260910-1136-central-rbac-standard-design.md](../plans/reports/brainstorm-260910-1136-central-rbac-standard-design.md)
- Migration 019 SQL: [central-rbac/src/db/migrations/019_rbac_v2_foundation.sql](../central-rbac/src/db/migrations/019_rbac_v2_foundation.sql)
- Onboarding new app: [central-rbac-app-onboarding.md](central-rbac-app-onboarding.md)
