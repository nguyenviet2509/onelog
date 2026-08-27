# Phase 03 — UI org display + admin identity header

**Priority**: P2 | **Effort**: 3h | **Status**: pending | **Depends**: Phase 01

## Context

- Backend đã enrich response với `organization` (Phase 01).
- UI type `Grant`, `ZitadelUser`, `UserDetail`, `Project` chưa có org field.
- Header sidebar hiện raw `sub` claim.
- Grant dialog có Project dropdown nhưng không filter roles + không gửi project_id → chỉ decorative.

## Overview

3 mảng UI:
1. Users list + drawer hiện org name.
2. Grant dialog refactor: Project → filter roles theo project.
3. Header top-right: display_name + avatar initial + dropdown Đăng xuất.

## Key insights

- JWT claim decode client-side: dùng `atob(token.split('.')[1])` + JSON.parse. Không cần lib nếu keep simple.
- Fallback chain profile: `name` → `preferred_username` → `email` → `sub` (last 6 chars).
- Grant dialog project→role filter: role type đã có `app_id`; project có `id` (zitadel_project_id). Map qua endpoint `/v1/apps` (đã tồn tại) để lookup `app_id → project_id`.

## Related code files

**Modify**:
- `central-rbac-ui/src/lib/types.ts` — thêm `organization`, `org`, `app_id` fields.
- `central-rbac-ui/src/pages/users/users-list-page.tsx` — column "Tổ chức".
- `central-rbac-ui/src/pages/users/user-detail-drawer.tsx` — badge org.
- `central-rbac-ui/src/pages/users/grant-dialog.tsx` — project→role filter, disable submit.
- `central-rbac-ui/src/components/layout/sidebar.tsx` — profile section top hoặc footer.

**Create**:
- `central-rbac-ui/src/hooks/use-me.ts` — JWT decode + profile fallback.

## Implementation steps

### 1. Update types

```typescript
// lib/types.ts
export interface Organization {
  id: string;
  name: string;
}

export interface Role {
  key: string;
  display_name: string;
  description?: string;
  parent_key?: string | null;
  app_id?: string | null; // ← from Migration 011
}

export interface Project {
  id: string;
  name: string;
  slug?: string;
  app_id?: string;
  org?: Organization | null; // ← from Phase 01
}

export interface Grant {
  id: string;
  project_id: string;
  project_name?: string;
  role_keys: string[];
  granted_at?: string;
  granted_by?: string;
}

export interface ZitadelUser {
  id: string;
  email: string;
  display_name: string;
  organization?: Organization | null; // ← from Phase 01
  grant_count: number | null;
}

export interface UserDetail extends ZitadelUser {
  grants: Grant[];
}
```

### 2. Create `hooks/use-me.ts`

```typescript
import { useMemo } from 'react';

interface JwtPayload {
  sub: string;
  name?: string;
  preferred_username?: string;
  email?: string;
}

interface MeProfile {
  id: string;
  displayName: string;
  email: string;
  initial: string;
}

function decodeJwt(token: string): JwtPayload | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

function getStoredToken(): string | null {
  // Same key as api/client.ts uses
  return localStorage.getItem('jwt') || sessionStorage.getItem('jwt');
}

export function useMe(): MeProfile | null {
  return useMemo(() => {
    const token = getStoredToken();
    if (!token) return null;
    const claims = decodeJwt(token);
    if (!claims) return null;
    const displayName =
      claims.name ||
      claims.preferred_username ||
      claims.email ||
      `User ${claims.sub.slice(-6)}`;
    return {
      id: claims.sub,
      displayName,
      email: claims.email ?? '',
      initial: displayName[0]?.toUpperCase() ?? '?',
    };
  }, []);
}
```

Note: verify chính xác token storage key trong `api/client.ts` — có thể `token`, `auth_token`, hoặc `jwt`. Grep + align.

### 3. Users list column "Tổ chức"

```tsx
// users-list-page.tsx table row
<td className="px-4 py-3 text-sm text-gray-600">
  {user.organization?.name ?? '—'}
</td>
```

Thêm header column:
```tsx
<th>TỔ CHỨC</th>
```

### 4. Drawer badge

```tsx
// user-detail-drawer.tsx sau block email
{user.organization && (
  <span className="inline-flex items-center gap-1 text-xs text-gray-500 mt-1">
    <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
    Tổ chức: {user.organization.name}
  </span>
)}
```

### 5. Grant dialog refactor

**State**:
- Đã có `selectedProject`, `selectedRole`. Refactor logic:

**Fetch**:
- `useQuery projects` giờ trả `Project[]` với `org` field.
- `useQuery roles` trả `Role[]` với `app_id`.
- `useQuery apps` (existing) trả `App[]` với `id + zitadel_project_id`.

**Filter roles**:
```typescript
const rolesForProject = useMemo(() => {
  if (!selectedProject) return [];
  const app = apps.find((a) => a.zitadel_project_id === selectedProject);
  if (!app) return [];
  return roles.filter((r) => r.app_id === app.id);
}, [selectedProject, roles, apps]);
```

**Project options format**:
```tsx
<option key={p.id} value={p.id}>
  {p.name}{p.org?.name ? ` · ${p.org.name}` : ''}
</option>
```

**Submit**:
- Disable button khi `!selectedProject || !selectedRole`.
- Reset `selectedRole` khi `selectedProject` change.

### 6. Header profile (sidebar top hoặc header component)

Reuse `use-me`:

```tsx
// components/layout/sidebar.tsx (thêm block top)
const me = useMe();
{me && (
  <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
    <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 font-semibold flex items-center justify-center text-sm">
      {me.initial}
    </div>
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium text-gray-900 truncate">{me.displayName}</div>
      <div className="text-xs text-gray-500 truncate">{me.email || me.id}</div>
    </div>
    <button onClick={handleLogout} title="Đăng xuất" className="...">
      <LogoutIcon className="w-4 h-4 text-gray-400" />
    </button>
  </div>
)}
```

Existing "Đăng xuất" button ở bottom sidebar giữ nguyên hoặc di dời — decide khi làm.

## Todo list

- [ ] Update `lib/types.ts` với Organization, org, app_id fields.
- [ ] Verify token storage key trong `api/client.ts`.
- [ ] Create `hooks/use-me.ts` với JWT decode + fallback.
- [ ] `users-list-page.tsx`: add column "Tổ chức".
- [ ] `user-detail-drawer.tsx`: add org badge.
- [ ] `grant-dialog.tsx`: refactor project→role filter + disable submit.
- [ ] `sidebar.tsx`: add profile block top.
- [ ] TypeScript clean.
- [ ] Build UI + deploy (docker rebuild central-rbac-ui).
- [ ] Regression test:
  - [ ] List users hiện org column.
  - [ ] Open Spike Tester drawer → badge "Tổ chức: spike-test".
  - [ ] Grant dialog: chọn "OneMCP Portal · Authway Internal" → roles hiện onemcp.viewer/editor/admin.
  - [ ] Grant onemcp.admin → outbox event mới, status=done.
  - [ ] Revoke: drawer update trong 2-3s.
  - [ ] Header hiện tên admin (không phải sub).

## Success criteria

- Không còn userId thô trên header.
- Grant dialog: submit khả dụng chỉ khi chọn đủ Project + Role, roles filter đúng theo project.
- Central RBAC UI reflect Zitadel org info tất cả điểm đã spec.
- No regression grant/revoke/list users.

## Risk

- **JWT storage key nhầm** → `useMe` return null → header trống. Fallback: hiện "Chưa đăng nhập" hoặc `sub` short.
- **Grant dialog logic bug**: Filter dùng app_id → project_id map. Test kỹ cross-org project.
- **Role filter loại role legacy** (app_id NULL, dạng rbac.admin/spike.role.a): những role này không thuộc project nào. Grant dialog hiện project "spike-project" → chỉ hiện spike.role.a/b (nếu app_id được set); role rbac.admin không hiện. Cần backfill migration cho role legacy? YAGNI: legacy roles map về default env project → tạm hiện. Decide khi làm.

## Security

- JWT decode client-side chỉ để display name. Không dùng để authz.
- Không log JWT ra console.

## Next

Sau Phase 03 xong → tất cả 3 concerns đóng. Commit, push, journal, deploy.
