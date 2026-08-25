# Code Review — Phase 4-5 Central RBAC (IP-first)

**Executive summary:** Phase 4 UI + Phase 5 backend/deploy configs are cohesive, security-conscious, and match IP-first constraints; a few real bugs need fixing before merge but nothing catastrophic. **Score: 8/10.**

## Scope
- UI: 27 files under `central-rbac-ui/src/` + Dockerfile + nginx.conf + vite.config + .env.example (LOC total ~1.6k)
- Backend: `routes/users.ts`, `routes/projects.ts`, `schemas/user-schemas.ts`, `lib/zitadel-user-search-client.ts`, `app.ts` diff
- Deploy: `docker-compose.review.yml`, `config/traefik-rbac-review-entrypoint.patch.yml`, `config/seed/*.yaml`, `scripts/bootstrap.ts`, `docs/deploy-review.md`

## Critical (block merge)

None.

## High (fix before ship)

### H1 — `redirect_uri` replace produces wrong post-logout URI when path differs
`src/auth/oidc-client.ts:20,27`

```ts
post_logout_redirect_uri: redirect_uri.replace('/callback', ''),
silent_redirect_uri: redirect_uri.replace('/callback', '/silent-renew'),
```
If `VITE_ZITADEL_REDIRECT_URI` = `http://10.200.0.125:8082/callback` → OK.
But **the review .env.example has that value while the plan V6 says review URL is `http://10.200.0.125:8082/`** — path collision is fine here, but the string-`.replace` is fragile: any future URI with `/callback` elsewhere (e.g. `/app/callback`) breaks silently.

Fix: derive from `new URL(redirect_uri)`:
```ts
const u = new URL(redirect_uri);
const post_logout = `${u.origin}/`;
const silent = `${u.origin}/silent-renew`;
```
Also — `/silent-renew` route is **not registered** in `router.tsx` (only `/login`, `/callback`, `/`). Silent renew iframe will 404 → automaticSilentRenew failures silent-swallowed. Either add a `/silent-renew` route with a minimal handler that calls `userManager.signinSilentCallback()`, or set `automaticSilentRenew:false` for review mode.

### H2 — Bulk grant sequential fan-out has no rate limit / cancellation
`src/hooks/use-bulk-grant.ts:25-33`
Selecting 200 users → 200 sequential requests to `POST /v1/assignments`, no cancel button, no progress. If user closes the browser mid-loop the state `isRunning=true` never resets (no cleanup on unmount).

Fix (KISS): add abort signal from `useEffect(()=>{controller.abort()})` on hook unmount; cap total (e.g. `if (users.length > 100) throw new Error("Chọn tối đa 100 người")`); optional running counter `${i+1}/${total}`.

### H3 — Zitadel v2 search endpoint URL likely wrong (or at minimum inconsistent with sibling clients)
`src/lib/zitadel-user-search-client.ts:111`

```ts
res = await mgmtPost('/v2/users', orgId, body);
```
Sibling clients use `/management/v1/users/_search`, `/management/v1/projects/{id}/roles/_search` etc. Zitadel v2 user-service search actually maps to `POST /v2/users` in newer builds, **but** the researcher report (`researcher-260822-1159-plan-validation.md`) explicitly vetted `POST /management/v1/users/_search` as available — that is the safer choice matching the rest of the codebase. Additionally:

- `x-zitadel-orgid` is sent (comment says intentional) but v2 is instance-scoped → **PAT needs IAM-level `iam.users.read` not org-level.** Fullstack report #88 flagged this as a verification gap.
- On non-2xx, error message returned to client includes raw HTTP status but the response `text.slice(0, 200)` is logged — good — however error message goes back verbatim to UI as `detail: msg` (users.ts:78,138) which can leak Zitadel internal errors.

Fix: (a) switch to `/management/v1/users/_search` for consistency + confirmed PAT scope; (b) redact `detail` on 502 responses (`return reply.status(502).send({error:'...'})` without `detail`).

### H4 — `enrichGrantCounts` will hammer Zitadel on every list page
`src/routes/users.ts:27-53`
For a search returning `limit=50`, this issues 50 × `listUserGrants` calls (10-parallel batches × 5 waves). Zitadel v1 rate limits default ~10 rps; at 200-user limit that's 200 calls per keystroke (debounced 300ms).

Fix: (a) since list is not cached (comment line 9), at least cache the per-user grant count in Redis with 60s TTL keyed `user-grant-count:v1:{uid}`; (b) drop from default response — mark `grant_count` optional and only fetch on hover / detail open. Current design is a Zitadel DoS waiting to happen when the org grows.

### H5 — Bulk assign `Set` mutation in React setState
`src/pages/users/users-list-page.tsx:41-49,51-54`

```ts
setSelectedRows((prev) => {
  const next = new Set(prev);  // OK — copy
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
});
```
Actually correct (copy first). But `toggleSelectAll` at line 52 passes `new Set(users.map(...))` — good. **No bug here** — remove this note.

Real issue: line 79 `onChange={() => {}}` is React anti-pattern — React logs a warning about controlled input without onChange. Prefer `readOnly` or move logic into onChange:
```tsx
<input type="checkbox" checked={...} onChange={(e) => toggleRowSelect(row.original.id, e as any)} />
```

### H6 — Bootstrap: transaction wraps 30+ tiny queries, no batching, but drops `role_permissions` before insert
`scripts/bootstrap.ts:214-228`
Correct + idempotent, but if the process crashes between DELETE and re-INSERT, the txn rolls back (safe). However bootstrap does **not** guard against duplicate keys in a role's `permissions[]` array (would trip `ON CONFLICT DO NOTHING` silently — fine, but hides seed bugs). Add a runtime check:
```ts
for (const role of ROLES) {
  const dup = role.permissions.filter((p, i, a) => a.indexOf(p) !== i);
  if (dup.length) { console.error(`role ${role.key} has duplicate perms: ${dup.join(',')}`); process.exit(1); }
}
```

Also: hard-check at line 141 correctly excludes `system.root` but the **`rbac.admin` role does not include `rbac.admin.read/write`** per plan rule (line 99-101 comment) — hard check pass. **But then how does the admin UI actually authorize?** `usePermissions.canWrite()` calls `hasPermission('rbac.admin.write')` (`use-permissions.ts:19`). Only `system.root` holds that permission → **no `rbac.admin`-role user can pass `canWrite()` in the UI.** This mismatches the plan intent that `rbac.admin` role has UI write access.

Fix: either (a) UI switches to role-based check (`user.roles?.includes('rbac.admin')`) instead of permission check, or (b) plan intent must be revisited. Currently the seed + UI check disagree — high severity because it silently breaks all `rbac.admin` write actions.

### H7 — `docker-compose.review.yml` attaches central-rbac to `authway-prod_edge` but drops its existing networks
`docker-compose.review.yml:67-79`
The `networks:` block lists **only** `authway-prod_edge`. If the existing standalone container was on `central-rbac-postgres` + `central-rbac-redis` networks, `docker compose up -d` reconciles the service and may detach it from those networks, breaking DB + Redis access. Comment at line 71-72 acknowledges this risk but the mitigation ("re-attach existing networks") isn't in the YAML.

Fix: explicitly enumerate all needed networks:
```yaml
networks:
  - authway-prod_edge
  - central-rbac_default  # or the actual db/redis network name
```
Or use `docker network connect authway-prod_edge central-rbac` manually and remove the `central-rbac` service from this compose (docs step 7 already suggests this — then the service block in compose is dead code and misleading; delete it).

## Medium (post-merge)

### M1 — `parsePermissions`/`parseRbacDegraded` doesn't verify JWT signature
`src/lib/utils.ts:25-49` — expected for a client that trusts the token it got from OIDC, but note: if an attacker steals a valid JWT and edits the payload client-side, the UI would grant fake permissions locally (backend still rejects). Acceptable for MVP; document that all authoritative checks are server-side.

### M2 — CSP allows `style-src 'unsafe-inline'`
`nginx.conf:21` — required by Tailwind runtime + Radix but worth revisiting for prod domain. No script-src `unsafe-inline` — good.

### M3 — Redis cache key `user-detail:v1:{id}` never invalidated on assignment mutation
`routes/users.ts:22-24` — 60s TTL is short so drift is bounded, but grant/revoke actions should also `redis.del(userDetailCacheKey(user_id))` to keep UI consistent.

### M4 — `enrichGrantCounts` swallows per-user failures silently → 0 count
`routes/users.ts:44-48` — UI displays "0 quyền" for users with real grants if Zitadel is flaky. Return a `grant_count_unavailable` boolean flag so UI can render "—" instead of misleading `0`.

### M5 — Bulk assign spec: `selectedProject` state read but never sent
`src/pages/users/grant-dialog.tsx:22,42` — user picks a project but `grant.mutate({ role_key })` doesn't include project. Backend `assignRoleToUser` presumably uses `ZITADEL_PROJECT_ID`. Either drop the Project dropdown (YAGNI — MVP is single-project per V9) or wire it end-to-end.

### M6 — `mgmtPost` retry on 5xx is unconditional — no retry-on-timeout distinction
`src/lib/zitadel-http.ts:52-57` — a hung Zitadel returning 500 twice = 6-sec latency. Acceptable, but consider circuit breaker if load grows.

### M7 — `docker-compose.review.yml` UI service missing pinned image digest
`docker-compose.review.yml:39` — `image: central-rbac-ui:phase04` uses mutable tag. For review-only OK; for prod-swap, pin digest.

### M8 — Users list search is not sanitized before Zitadel query
`routes/users.ts:67` — `q` is passed straight into `TEXT_QUERY_METHOD_CONTAINS`. Zitadel treats this as literal string (not a filter DSL), so no injection risk, but Zod schema only bounds length (200 chars) — consider stripping control chars.

## Low (nice-to-have)

- L1 `src/api/users.ts:6-8` — TODO comment says endpoints not implemented; it now IS implemented in Phase 5. Delete comment.
- L2 `src/api/projects.ts:5-6` — same stale TODO; delete.
- L3 `docker-compose.review.yml:71-77` — comment says "re-use existing env" but `env_file: /opt/central-rbac/.env` hardcodes VPS path — will fail on any other host. Move to a `.env` variable.
- L4 `bootstrap.ts:23,251-262` — `checkSeedFiles` runs before `bootstrap()` but is fire-and-forget (returns void, no await). Order via top-level is fine, but the seed data is hardcoded in TS anyway (line 6-7 comment) — this check is decorative. Delete or gate behind an env flag.
- L5 `src/pages/users/user-detail-drawer.tsx:133` — `roleKey={revokeTarget.role_keys[0]}` sends only the first role_key. If a grant has multiple roles, revoke only removes the first shown — user won't see the others still granted. Show ambiguity in UI or revoke all.
- L6 `src/hooks/use-permissions.ts:14-16` — `hasPermission` case-sensitive; document that convention.
- L7 `src/pages/users/users-list-page.tsx:30-34,103-104` — `eslint-disable-next-line react-hooks/exhaustive-deps` twice — the debounce ref stays stable but consider `useMemo(() => debounce(...), [])` pattern to avoid the disable.
- L8 `deploy-review.md:69` — build arg uses `https://10.200.0.125` for `VITE_ZITADEL_ISSUER` but `.env.example` uses `http://` — inconsistency; verify what Zitadel actually listens on for the IP-first review mode.

## Positive callouts
- Bootstrap `enforceRbacPermRule()` + `parent_key` cycle-safe ordering + txn rollback — production-quality safety guard.
- `verifyJwt` covers `azp`, `iss`, `aud`, JWKS kid-miss refresh, degraded-mode fail-close on mutations — good defence-in-depth.
- Deploy runbook `docs/deploy-review.md` is concrete, has rollback + swap-to-domain path (V6/V7 consistency).

## Modularization / naming
- All UI files ≤ 158 LOC, kebab-case — compliant with 200-LOC rule.
- `bootstrap.ts` = 266 LOC, exceeds — could split seed data into `config/seed/permissions.ts` + `config/seed/roles.ts` mirrored from YAML (but YAGNI: source-of-truth is the YAML per file header, and hardcoded array is intentional — accept as-is).

## Unresolved questions
1. Is `POST /v2/users` (instance-level, IAM PAT scope) the intended Zitadel endpoint, or should it be `POST /management/v1/users/_search` (org-level) as vetted by researcher-260822-1159? Fullstack-260825-1030 flagged PAT scope as unverified.
2. Does `rbac.admin` role need to actually grant UI write, or is the UI check meant to be role-based (`roles.includes('rbac.admin')`) instead of permission-based (`rbac.admin.write`)? H6 blocks review flow until decided.
3. When central-rbac container is attached to `authway-prod_edge` via compose reconciliation, are the pre-existing DB/Redis networks preserved? Needs manual dry-run on authway-vps before deploy.

**Status:** DONE_WITH_CONCERNS
**Summary:** Phase 4-5 code is coherent and IP-first-aligned; 7 High findings (esp. H3 endpoint choice, H4 Zitadel fan-out, H6 permission-vs-role mismatch, H7 network reconciliation) should be resolved before merge or explicitly deferred with tickets.
**Concerns/Blockers:** H6 (rbac.admin cannot write in UI due to permission-check mismatch) is functionally blocking — recommend fixing UI `canWrite()` to `roles.includes('rbac.admin') || hasPermission('rbac.admin.write')` before shipping. H3 endpoint choice needs a 5-min authway-vps curl test to confirm PAT scope.
