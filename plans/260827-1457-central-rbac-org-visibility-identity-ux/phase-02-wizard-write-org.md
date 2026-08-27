# Phase 02 — Wizard writes zitadel_org_id

**Priority**: P2 | **Effort**: 30m | **Status**: pending | **Blocks**: Phase 03 wizard registrations UX

## Context

- Migration 012 thêm `apps.zitadel_org_id` NULL-able.
- Backfill manual chỉ set `onemcp` row. Wizard mới tạo app sau này phải tự ghi.
- Zitadel `POST /management/v1/projects` (addProject) response chứa `details.resourceOwner` = org sở hữu project.

## Overview

Update `POST /v1/admin/apps` wizard: extract `resourceOwner` từ addProject response → truyền vào INSERT `rbac.apps`.

## Related code files

**Modify**:
- `central-rbac/src/routes/admin-apps.ts` — capture orgId từ response, thêm vào `insertApp`.
- `central-rbac/src/lib/zitadel-project-client.ts` — verify `addProject` return `resourceOwner` hoặc thêm field.

**Optional**:
- Backfill 1-off SQL cho apps hiện có ngoài `onemcp` (không có, skip).

## Implementation steps

### 1. Verify `addProject` response mapping

Đọc `zitadel-project-client.ts`:
- Zitadel response format: `{ id, details: { resourceOwner, ... } }`.
- Current `addProject` return `{ id }` — cần extend thành `{ id, orgId }`.

Update:
```typescript
export async function addProject(name: string): Promise<{ id: string; orgId: string }> {
  const res = await mgmtPost('/management/v1/projects', ORG_ID, { name });
  // ... existing error handling
  const body = await res.json();
  return { id: body.id, orgId: body.details?.resourceOwner ?? ORG_ID };
}
```

### 2. Update `admin-apps.ts` wizard flow

```typescript
// Step 5 in current handler
const result = await addProject(name);
projectId = result.id;
projectOrgId = result.orgId; // ← new

// Step 7 insertApp
const newApp = await insertApp(
  slug, name, projectId, clientId, manifest_url ?? null, adminSub,
  projectOrgId, // ← new param
);
```

### 3. Update `insertApp` signature + SQL

```typescript
async function insertApp(
  slug: string, name: string, projectId: string, clientId: string,
  manifestUrl: string | null, adminSub: string,
  zitadelOrgId: string, // ← new
): Promise<DbApp> {
  const { rows } = await writerPool.query<DbApp>(
    `INSERT INTO rbac.apps
       (slug, name, zitadel_project_id, zitadel_org_id, zitadel_client_id, manifest_url, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, slug, name, zitadel_project_id, zitadel_org_id, zitadel_client_id, manifest_url, created_at, created_by`,
    [slug, name, projectId, zitadelOrgId, clientId, manifestUrl, adminSub],
  );
  if (!rows[0]) throw new Error('INSERT rbac.apps returned no rows');
  return rows[0];
}
```

### 4. Update `DbApp` interface

Thêm `zitadel_org_id: string` field.

### 5. Also update `createDefaultRoles` orgId passthrough

`admin-apps.ts createDefaultRoles(appSlug, appId, zitadelProjectId, adminSub)` gọi `createRoleWithSync` → cần orgId cho `add_project_role` outbox event dùng đúng owner org (Migration 012 fix cho cross-org, tương tự user grants).

Extend:
```typescript
await createRoleWithSync(
  { key, description, app_id: appId },
  undefined,
  zitadelProjectId,
  zitadelOrgId, // ← new
);
```

Và `role-sync.ts createRoleWithSync(input, corr, projectIdOverride, orgIdOverride)` — mirror `assignRoleToUser` pattern.

## Todo list

- [ ] Update `zitadel-project-client.ts addProject` return `{id, orgId}`.
- [ ] Update `admin-apps.ts` capture orgId + pass qua insertApp + createDefaultRoles.
- [ ] Extend `insertApp` SQL + signature với `zitadel_org_id`.
- [ ] Extend `role-sync.ts createRoleWithSync` accept optional `orgIdOverride`.
- [ ] Update `DbApp` interface + related types.
- [ ] TypeScript clean.
- [ ] Deploy backend rebuild.
- [ ] Smoke test: tạo 1 app test qua wizard → verify `SELECT * FROM rbac.apps WHERE slug='test-xxx'` có `zitadel_org_id`.

## Success criteria

- Sau wizard tạo app mới: row `rbac.apps` có `zitadel_org_id` = SA's default org (hoặc org được chỉ định).
- Default roles enqueue outbox `add_project_role` với `orgId` = project owner org → không bị dead vì cross-org.

## Risk

- **SA operates in fixed org context**: PAT default org = `ZITADEL_ORG_ID` env (spike-test). Vậy addProject tạo project owned by spike-test → org = spike-test. Muốn tạo project cho org khác cần chọn org khi gọi API. YAGNI: chỉ tạo trong SA's org, deferred multi-org creation cho sau.
- **Existing apps (onemcp)** already backfilled — không cần re-run.

## Security

- SA phải có `project.create` scope trong org đang được target. Đã confirm ở Phase 07.

## Next

Phase 03 UI dùng field `zitadel_org_id` (qua enrichment Phase 01) để hiển thị project options "OneMCP · Authway Internal".
