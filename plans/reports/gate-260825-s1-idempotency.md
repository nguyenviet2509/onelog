# Gate S1 — AddUserGrant Idempotency

**Date:** 2026-08-25  
**Tested against:** Zitadel at `http://10.200.0.125`, org `spike-test` (`387656897144029188`)  
**Project:** `spike-project` (`387656954924761092`)  
**Test user:** `spike-user@spike-test.local` (`387657093185798148`)

---

## Test A — AddUserGrant duplicate (same project, existing grant exists)

**Call:** `POST /management/v1/users/{userId}/grants` with `{projectId, roleKeys:["spike.role.a"]}`  
**Precondition:** User already has grant `387657728840957956` with roles `[spike.role.a, spike.role.b]`  
**Result:** **HTTP 409** — `{"code":6,"message":"User grant already exists (V3-DKcYh)"}`

**Key finding:** Zitadel treats one grant per (user, project) as unique. A second POST for the same project returns 409 regardless of roleKeys.

---

## Test B — AddUserGrant with additional roles when grant exists

**Call:** `POST /management/v1/users/{userId}/grants` with `{projectId, roleKeys:["spike.role.a","spike.role.b","spike.role.c"]}`  
**Precondition:** User already has grant for same project  
**Result:** **HTTP 409** — `User grant already exists`

**Key finding:** AddUserGrant is NOT a merge operation. It cannot add roles to an existing grant. For role additions, use **UpdateUserGrant (PUT)** with full replacement set.

**UpdateUserGrant behavior:** `PUT /management/v1/users/{userId}/grants/{grantId}` with `{roleKeys:[...]}` — REPLACES the entire role set. Returns 200. Idempotent if called with same roleKeys.

---

## Test C — RemoveUserGrant twice (idempotency)

**First call:** `DELETE /management/v1/users/{userId}/grants/{grantId}` → **HTTP 200**  
**Second call:** same grantId → **HTTP 404** — `{"code":5,"message":"User grant not found (COMMAND-1My0t)"}`

**Key finding:** RemoveUserGrant is NOT idempotent. Second call returns 404.

---

## Test D — AddProjectRole / RemoveProjectRole idempotency

**AddProjectRole first:** `POST /management/v1/projects/{id}/roles` with `{roleKey:"spike.role.d"}` → **HTTP 200**  
**AddProjectRole second:** same roleKey → **HTTP 409** — `{"code":6,"message":"Role already exists"}`  
**RemoveProjectRole first:** `DELETE /management/v1/projects/{id}/roles/{key}` → **HTTP 200**  
**RemoveProjectRole second:** same key → **HTTP 200** (idempotent!) — same response body as first call

---

## Decision Matrix

| Operation | Zitadel behavior | Outbox worker strategy |
|-----------|-----------------|----------------------|
| `add_project_role` | 409 on duplicate | Treat 409 as success (idempotency won) |
| `remove_project_role` | 200 idempotent on second call | No special handling needed |
| `add_user_grant` | 409 on duplicate project grant | Treat 409 as success — our outbox tracks 1 grant per (user, project) |
| `update_user_grant` | 200 idempotent (replaces role set) | Use for role additions to existing grant |
| `remove_user_grant` | 404 on second call | Treat 404 as success (already removed = goal achieved) |

---

## Architecture Implications

1. **One grant per (user, project)**: Zitadel enforces this constraint. Our outbox/assignment model must store grantId and use UpdateUserGrant (not AddUserGrant) when adding roles to a user who already has a grant for that project.

2. **Assignment service design change**: 
   - First call for user+project: `AddUserGrant` → store returned `userGrantId`  
   - Subsequent role additions for same user+project: `UpdateUserGrant` (PUT) with full merged role set
   - This means our Central DB must track the Zitadel `grantId` to enable updates

3. **Outbox worker 409 handling**: On `add_user_grant`, treat 409 as success (grant already exists → re-fetch grantId if needed)

4. **Outbox worker 404 handling**: On `remove_user_grant`, treat 404 as success (grant already removed)

---

## S1 Gate: PASS

Decision matrix locked. Day 2 implementation proceeds with:
- UpdateUserGrant pattern for multi-role assignments
- 409 → success for add operations
- 404 → success for remove operations
- Central DB must store Zitadel `grantId` for update operations
