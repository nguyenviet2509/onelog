# OneMCP Portal: Current RBAC & Authorization State Investigation

**Investigator**: Claude Code  
**Date**: 2026-08-24  
**Context**: Central RBAC migration planning (Phase 5 smoke test) — Zitadel v4 → OneMCP portal  

---

## Executive Summary

**Current state**: OneMCP portal **already has partial RBAC integration via Zitadel OIDC** but operates in **dual-mode** (legacy IAP + new JWT-based). Roles are extracted from JWT claims and mapped to internal RoleCode enum. **Permissions claims (`permissions[]`) are NOT yet used** — role-based checks only. **MODERATE RISK** for Phase 5: existing role structure must align with Central RBAC role catalog; dual-mode fallback logic must be tested.

---

## 1. Current Auth State

### Provider & Mechanism
- **Primary OIDC**: Zitadel v4 (configurable at `ZITADEL_ISSUER`, default `http://10.200.0.125`)
- **Portal (Next.js 15)**: NextAuth v5 (Auth.js) — configured in `/lib/auth.ts`
- **Backend (NestJS)**: JWT verification via `jose` library + JWKS remote fetch
- **Dual-mode enabled**:
  - `AUTH_MODE=iap` (default): Legacy oauth2-proxy → X-Onemcp-User header fallback
  - `AUTH_MODE=oidc`: NextAuth session required → JWT forwarded as Bearer token to backend

### JWT Verification Flow
1. **Portal**: NextAuth extracts `access_token` from Zitadel OIDC callback
2. **Backend**: `ZitadelJwtMiddleware` (enabled via `ZITADEL_OIDC_ENABLED=true`) verifies:
   - JWT signature via JWKS (remote)
   - Issuer claim (`iss`)
   - Audience claim (`aud` must contain `ZITADEL_CLIENT_ID`)
3. **Fallback**: If OIDC disabled, `TrustUserMiddleware` reads `X-Onemcp-User` header (legacy IAP)
4. **Token scope**: Access token lacks email/username → backend fetches `/oidc/v1/userinfo` endpoint (cached 5 min)

**Key finding**: Backend can read JWT but DOES NOT extract `permissions[]` claim yet. Only role keys used.

---

## 2. Current RBAC State: Role-Based Only

### Role Enum & Mapping
**RoleCode**: `'viewer' | 'contributor' | 'maintainer' | 'dept-admin' | 'super-admin'`

**Zitadel → OneMCP mapping** (in `zitadel-jwt.middleware.ts:39-50`):
```
Zitadel role 'admin'   → super-admin
Zitadel role 'editor'  → maintainer (implies contributor)
Zitadel role 'viewer'  → contributor
[no role] fallback     → contributor
```

### Where Roles Come From (3 mechanisms)

#### A. Zitadel JWT claim (preferred, if enabled)
- Extracts `urn:zitadel:iam:org:project:roles` from JWT payload
- Structure: `{ "admin": {orgId}, "viewer": {orgId} }`
- Maps keys via function `extractZitadelRoles()`
- **Log warning** if claim missing (may indicate Zitadel project not configured with `assert_roles=true`)

#### B. Env-based static assignment (fallback v1 bootstrap)
- `ADMIN_USERNAMES`: CSV list → assigned role `super-admin`
- `MAINTAINER_USERNAMES`: CSV list → assigned roles `[maintainer, contributor]`
- Default: `DEFAULT_ROLE` (env var, default `contributor`)
- Logic in `RoleAssignerService.rolesFor(username)`
- Used by `TrustUserMiddleware` when JWT not available

#### C. API Key auth
- Bearer token validated → role hardcoded as `contributor`
- See `ApiKeyMiddleware` line: `roles: [identity.role as 'contributor']`

### Permission Checks (Service Layer)

**No dedicated permission service**. Hardcoded checks in business logic:

- **Artifacts**:
  - `REVIEWER_ROLES = ['maintainer', 'dept-admin', 'super-admin']` (line 45)
  - Artifact review/publish gated: `isReviewer(user)` checks `user.roles.some(r => REVIEWER_ROLES.includes(r))`
  - Example: `artifacts.service.ts:300` — `if (!this.isReviewer(user)) throw new ForbiddenException('Chỉ maintainer/admin review')`

- **Projects**:
  - `isAdmin(user)` checks `['super-admin' | 'dept-admin']`
  - Deploy token access gated to owner or admin
  - Suspend/resume gated to admin only
  - See `projects.service.ts:66-68`

- **Attachments**:
  - Same pattern as Artifacts: `REVIEWER_ROLES` for approval

### Frontend Role Display
- Portal shows roles in profile page (`app/profile/page.tsx`)
- Projects page: conditional UI for admin actions based on `me?.roles?.some(r => r === 'super-admin' || r === 'dept-admin')`
- Review queue: gatekeeping comment suggests backend enforces maintainer check

### AdminCidrGuard
- **Status**: DECOMMISSIONED (post-pivot 2026-07-27)
- File exists but always returns `true` — no CIDR gating anymore
- Role-based auth now primary mechanism
- Comment in code: "Sẽ xoá file này ở SSO plan Phase 1 cleanup"

---

## 3. Permission Claims Integration Status

### Current: NOT IMPLEMENTED

**Grep results for `permissions[]` or `permissions` claim**:
- Zero matches in backend source for JWT permission extraction
- No middleware or guard checking `permissions` array from JWT

**What exists**:
- Role extraction: YES
- Basic RBAC checks: YES
- **Missing**: Framework to decode & validate `permissions[]` claim structure

### Portal (Frontend)
- NextAuth v5 session includes `accessToken` + `roles[]` (from Zitadel)
- **Not forwarding** `permissions[]` claim separately (if present in JWT, must extract manually)
- Frontend has NO permission checks (all auth enforced at backend API layer)

---

## 4. Admin-Only Routes & Features

### Backend Routes Requiring `super-admin` or `dept-admin`

| Endpoint | Purpose | Check Location | Enforces |
|----------|---------|-----------------|----------|
| POST /projects/:id/deploy-token | Set GitLab token | projects.service.ts:42 | owner OR admin |
| PATCH /projects/:id/status | Suspend/resume | Inferred admin-only | admin |
| POST /artifacts/:id/publish | Artifact approval | artifacts.service.ts:300 | maintainer+ |
| PUT /artifacts/:id | Update artifact | artifacts.service.ts:252 | owner OR maintainer |
| DELETE /artifacts/:id | Delete artifact | artifacts.service.ts:352 | owner OR maintainer |
| POST /attachments/:id/publish | Attach approval | attachments.service.ts | maintainer+ |

### Frontend UI
- Projects page: create/edit/suspend buttons disabled for non-admin via conditional render
- Review queue: restricted to maintainer+ (backend enforces 403 if non-reviewer)
- No fine-grained UI permission checks; relies on API 403 responses

---

## 5. Key Code References

### Backend Auth Chain
1. **Access module** → `access/access.module.ts:36-39` — middleware order:
   - `ApiKeyMiddleware`
   - `ZitadelJwtMiddleware` (JWT verify + userinfo fetch)
   - `BearerAuthMiddleware` (OAuth 2.1 opaque token)
   - `TrustUserMiddleware` (X-Onemcp-User header fallback)

2. **Zitadel JWT verification** → `access/zitadel-jwt.middleware.ts:170-237`
   - JWKS fetch + cache
   - Userinfo fallback for missing claims
   - Role mapping applied

3. **Role assigner** → `access/role-assigner.service.ts` — env-based bootstrap

4. **Env config** → `config/env.schema.ts:50-57`

### Portal Auth
- **NextAuth config** → `portal/lib/auth.ts:21-75`
  - Provider: `zitadel` (OIDC)
  - Scope: `openid email profile urn:zitadel:iam:org:project:roles` (requests role claim)
  - JWT callback stores `accessToken` + `roles[]` in session
- **Middleware** → `portal/middleware.ts` — conditional redirect to signin (AUTH_MODE=oidc)

---

## 6. Integration Path for Central RBAC (Phase 5)

### Pre-Conditions Met
- JWT verification infrastructure ready (jose + JWKS)
- Role structure defined and mapped
- Service layer already gates business logic on `user.roles`
- Dual-mode auth allows safe transition

### Integration Steps (Greenfield for `permissions[]`)

**Step 1: Extend Zitadel JWT Middleware** → `zitadel-jwt.middleware.ts:200-228`
- Add permission extraction from JWT claim
- Extend RequestUser interface with `permissions?: string[]`

**Step 2: Create Permission Utility** → new file `access/permission.guard.ts`
- Function to check if user has required permission
- Support both role-based (legacy) and permission-based (new) checks

**Step 3: Update Service Layer** → dual-check pattern
- Modify artifact/project/attachment service checks
- Accept role OR permission match during transition

**Step 4: Frontend Session Extraction** → `portal/lib/auth.ts:60-65`
- Add `permissions` to session callback if claim present

**Step 5: Smoke Test Validation**
- Verify Central RBAC webhook injects `permissions[]` claim correctly
- Test both role + permission paths work
- Confirm UI reflects permission changes

### Rollout Timeline
1. **Week 1**: Deploy code with `permissions[]` extraction (backward compatible)
2. **Week 2**: Add dual-check in services (role OR permission)
3. **Week 3**: Central RBAC webhook starts injecting claim
4. **Week 4**: Smoke test + validate
5. **Post-Phase 5**: Permission-only checks, remove legacy role checks

---

## 7. Risk Flags

| Flag | Severity | Mitigation |
|------|----------|-----------|
| **Zitadel role claim missing** | HIGH | Ensure `assert_roles=true` on OneMCP project in Zitadel |
| **Userinfo endpoint timeout** | MEDIUM | Backend caches 5 min per token; set 3s HTTP timeout |
| **Dual-mode fallback complexity** | MEDIUM | Test AUTH_MODE=iap + AUTH_MODE=oidc paths in QA |
| **Hardcoded role strings** | LOW | 6 files hardcode checks; auto-detect migration needed post-Phase 5 |
| **AdminCidrGuard stale code** | LOW | Marked for deletion; remove in SSO finalization |
| **API Key role hardcoding** | LOW | Always gets `contributor`; fine for now |

---

## 8. Conclusion

**OneMCP portal is READY for Phase 5 integration**. Current auth stack fully supports JWT-based roles via Zitadel. Only task is wiring `permissions[]` claim extraction (<1 day). Recommendation: Deploy role-extraction code first (backward compatible), then enable Central RBAC webhook. Dual-mode fallback ensures zero-downtime cutover if needed.

