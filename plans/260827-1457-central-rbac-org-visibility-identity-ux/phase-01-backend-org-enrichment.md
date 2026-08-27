# Phase 01 — Backend org enrichment (lazy Redis cache)

**Priority**: P2 | **Effort**: 1.5h | **Status**: pending

## Context

- Brainstorm: [../reports/brainstorm-260827-1457-central-rbac-org-visibility-identity-ux.md](../reports/brainstorm-260827-1457-central-rbac-org-visibility-identity-ux.md)
- Migration 012 đã thêm `apps.zitadel_org_id` (260827 session earlier).
- Existing `zitadel-mgmt-client.ts` chỉ có user/grant/role — chưa có org lookup.

## Overview

Fetch Zitadel org detail (name) qua Management API + cache Redis 5min. Enrich 3 route responses.

## Key insights

- Zitadel Management endpoint: `GET /management/v1/orgs/:id` cần header `x-zitadel-orgid: :id` (self-scoped) hoặc admin PAT.
- Central RBAC SA có PAT bypass (đã dùng ở role/user-grant sync).
- N users → tối đa N unique orgIds. Fetch DISTINCT rồi enrich → tránh N+1.

## Requirements

**Functional**:
- `getOrgById(orgId)` trả về `{id, name, primaryDomain}`.
- List `/v1/users`: mỗi user có `organization: {id, name}` hoặc `null`.
- Detail `/v1/users/:id`: field `organization` như trên.
- `/v1/projects` (hoặc endpoint list projects cho grant dialog): mỗi project có `org: {id, name}`.

**Non-functional**:
- Cache Redis TTL 300s. Miss → fetch + set.
- Zitadel error → return `null` (không fail toàn bộ request).
- Không blocking hot path grant/revoke (chỉ trên list/detail user).

## Architecture

```
GET /v1/users
  → searchUsers(q, limit, offset)
  → collect unique orgIds from results
  → Promise.all(orgIds.map(getOrgById))  ← Redis-cached
  → merge orgName vào từng user
  → return { data: [...], total }

GET /v1/users/:id
  → getUserById + listUserGrantsAllOrgs (existing)
  → getOrgById(user.resourceOwner) ← new
  → merge organization vào detail

GET /v1/projects
  → SELECT apps.slug, name, zitadel_project_id, zitadel_org_id FROM rbac.apps
  → Promise.all(distinct zitadel_org_id → getOrgById)
  → merge org name vào từng project
  → return { data: [...] }
```

## Related code files

**Create**:
- `central-rbac/src/lib/zitadel-org-client.ts` — HTTP client + Redis cache.

**Modify**:
- `central-rbac/src/routes/users.ts` — enrich list + detail.
- `central-rbac/src/routes/projects.ts` — enrich (or create if missing endpoint).
- `central-rbac/src/lib/zitadel-user-search-client.ts` — verify `resourceOwner` field returned (dùng để lookup home org).

## Implementation steps

### 1. Create `zitadel-org-client.ts`

```typescript
// central-rbac/src/lib/zitadel-org-client.ts
import { mgmtGet } from './zitadel-http.js';
import { redis } from './redis-client.js';
import { logger } from './logger.js';

const CACHE_TTL_SEC = 300;
const cacheKey = (id: string) => `org:v1:${id}`;

export interface OrgSummary {
  id: string;
  name: string;
  primaryDomain: string;
}

export async function getOrgById(orgId: string): Promise<OrgSummary | null> {
  if (!orgId) return null;
  const key = cacheKey(orgId);
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as OrgSummary;
  } catch { /* redis down → fall through */ }

  try {
    const res = await mgmtGet(`/management/v1/orgs/${orgId}`, orgId);
    if (!res.ok) {
      logger.warn({ orgId, status: res.status }, 'zitadel-org: fetch non-2xx');
      return null;
    }
    const body = await res.json() as { org?: { id: string; name: string; primaryDomain?: string } };
    if (!body.org) return null;
    const summary: OrgSummary = {
      id: body.org.id,
      name: body.org.name,
      primaryDomain: body.org.primaryDomain ?? '',
    };
    redis.setex(key, CACHE_TTL_SEC, JSON.stringify(summary)).catch(() => {});
    return summary;
  } catch (err) {
    logger.warn({ orgId, err }, 'zitadel-org: fetch failed');
    return null;
  }
}

export async function getOrgsBatch(orgIds: string[]): Promise<Map<string, OrgSummary>> {
  const unique = Array.from(new Set(orgIds.filter(Boolean)));
  const results = await Promise.all(unique.map((id) => getOrgById(id).then((o) => [id, o] as const)));
  const map = new Map<string, OrgSummary>();
  for (const [id, org] of results) {
    if (org) map.set(id, org);
  }
  return map;
}
```

Note: verify `mgmtGet` helper tồn tại trong `zitadel-http.ts`. Nếu chỉ có `mgmtPost`/`mgmtPut`/`mgmtDelete` → thêm `mgmtGet` tương tự pattern.

### 2. Enrich `routes/users.ts`

- After `searchUsers`, collect `user.resourceOwner` (hoặc `orgId`) unique.
- Call `getOrgsBatch(orgIds)` → Map.
- Enrich mỗi user row với `organization: orgMap.get(u.resourceOwner) ?? null`.
- Same cho detail `/v1/users/:id`.

Verify `zitadel-user-search-client.ts` return `resourceOwner` field. Nếu không → tune search response mapping.

### 3. Enrich `routes/projects.ts`

Kiểm tra endpoint list projects hiện tại (có thể ở [routes/projects.ts](../../central-rbac/src/routes/projects.ts) hoặc merge vào `admin-apps.ts`):
- SELECT ... FROM rbac.apps.
- Collect DISTINCT zitadel_org_id.
- `getOrgsBatch` → merge `org: {id, name}` vào từng project.

Nếu endpoint chưa tồn tại → tạo `GET /v1/projects` mới cho grant dialog dùng.

## Todo list

- [ ] Grep verify `mgmtGet` tồn tại trong `zitadel-http.ts`. Nếu không, thêm.
- [ ] Create `src/lib/zitadel-org-client.ts` với `getOrgById` + `getOrgsBatch`.
- [ ] Verify `zitadel-user-search-client.ts` return `resourceOwner` (fetch mẫu 1 user để check).
- [ ] Update `routes/users.ts` list handler: enrich với `getOrgsBatch`.
- [ ] Update `routes/users.ts` detail handler: enrich với `getOrgById`.
- [ ] Locate/create `routes/projects.ts` list endpoint: enrich với `getOrgsBatch`.
- [ ] TypeScript `npx tsc --noEmit` clean.
- [ ] Deploy: tar → authway-vps → docker build → up.
- [ ] Smoke test: `curl /v1/users` verify có `organization.name`.

## Success criteria

- `GET /v1/users` response: mỗi user row có key `organization` (object hoặc null).
- `GET /v1/users/387657093185798148` (Spike Tester) → organization = { id: 387656897144029188, name: "spike-test" }.
- `GET /v1/projects` (nếu có) → mỗi project có `org: {id, name}`.
- Redis key `org:v1:*` populate sau lần đầu.
- No regression: existing user list/detail vẫn work.

## Risk

- **Zitadel org endpoint permission**: SA PAT có scope org.read chưa? Nếu 403 → cần update SA project role. Test trước.
- **searchUsers không trả resourceOwner**: fallback listUserGrants→grant.orgId? Nhưng SA users không có grant → org null. Chấp nhận.
- **N unique orgs > 10**: N calls first-time. Acceptable ở scale hiện tại (~3 orgs).

## Security

- Cache Redis không chứa data nhạy cảm (chỉ id + name).
- Không expose Zitadel internal fields.

## Next

Phase 02 (wizard write org_id) độc lập nhưng nên làm sau Phase 01 để `/v1/projects` enrich được data mới.
