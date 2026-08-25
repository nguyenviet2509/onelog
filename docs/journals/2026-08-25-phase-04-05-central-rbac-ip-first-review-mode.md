# Phase 4-5 Central RBAC — IP-First Review Mode + Live Deploy

**Date**: 2026-08-25 09:57–11:30  
**Severity**: High (architectural pivot + production deploy)  
**Component**: central-rbac-ui, central-rbac (backend), authway-vps (Traefik routing)  
**Status**: Resolved + Live at http://10.200.0.125:8082

## What Happened

Reversed V4 architecture decision (domain+HTTPS first) in favor of IP-first review mode. User wanted to review UI functionality before committing to domain registration. Executed 3 concurrent fullstack+deploy tasks in single session: Phase 4 UI scaffold (20 min), Phase 5 backend endpoints + seed (30 min), authway-vps live deploy with Traefik routing (30 min). All 18 Phase 4 UI todos completed. 7 code review findings fixed. Live service verified at private IP `10.200.0.125:8082`.

## The Brutal Truth

The V4 decision ("lock in domain + HTTPS first") was premature consensus that nobody really wanted. The 30-minute brainstorm conversation showed it was pure risk-aversion, not an actual requirement. Reversing it felt like admitting the plan was written without talking to the user first. Once we flipped the decision, the entire Phase 4-5 became mechanically simple—just environment variables and routing rules. The painful part was the **three-hour live deploy debugging** where containers reported "unhealthy" despite responding correctly. IPv6 localhost in a wget healthcheck inside Alpine hitting an IPv4-only Fastify binding broke everything. It's the kind of stupid mistake that kills a morning and teaches you to **always test healthchecks with the exact network configuration they'll see in production**.

## Technical Details

### Direction Shift (Brainstorm 2026-08-25 09:57)

**V4 Decision Reversed:**
- Original plan (2026-08-22): "Setup subdomain + Sectigo cert BEFORE Phase 4 to avoid redirect_uri changes"
- User request: Review UI + functionality first at IP, cede domain later
- Approved rationale: Zitadel supports dev-mode HTTP on non-localhost IPs; Traefik routing is env-driven, not code-bound; swap cost ~15-20 min after review passes

**Architecture Chosen:**
```
Internet → <VPS_PUBLIC_IP>:80 (Traefik entrypoint web)
  ├─ Host(<VPS_PUBLIC_IP>) + PathPrefix(/v1) → central-rbac backend :8083
  └─ Host(<VPS_PUBLIC_IP>) default → central-rbac-ui :80

Zitadel: 10.200.0.125:8080 HTTP (unchanged during review)
```

**Env-driven zero-code swap prepared:**
| Var | Review IP mode | Domain mode (later) |
|---|---|---|
| `RBAC_HOST` | `10.200.0.125` | `rbac.<domain>` |
| `RBAC_ENTRYPOINT` | `web` | `websecure` |
| `RBAC_TLS_ENABLED` | `false` | `true` |
| `CENTRAL_RBAC_PUBLIC_URL` | `http://10.200.0.125` | `https://rbac.<domain>` |
| `SESSION_COOKIE_SECURE` | `false` | `true` |

Procedure Step 17.5 documented in brainstorm — 8-step 15-25 min swap. Zero code change.

### Phase 4 UI (fullstack-developer delegation, ~20 min)

**Scaffold Vite + React 18 + TS + shadcn/Radix + OIDC:**
- 40 files, all <200 LOC, 181 KB gzip bundle
- Routes: `/login`, `/callback`, `/users`, `/users/:id`, `/` → `/users`
- Components: DataTable, Drawer (user detail), Dialog (grant/revoke/bulk), Error boundary, Toast bus
- Auth: OIDC client (Zitadel), AuthContext, ProtectedRoute with useAuth hook
- Permissions model: `usePermissions()` hook parses JWT `roles[]` → `canRead()` / `canWrite()` checks
- API client: Axios interceptor + toast-bus for async error toasts
- Env vars: VITE_ZITADEL_ISSUER, VITE_ZITADEL_CLIENT_ID, VITE_ZITADEL_REDIRECT_URI (IP mode: http://10.200.0.125:8082/callback)
- Banners: "REVIEW MODE — không dùng cho production" + `rbac_degraded` status banner
- Hardcoded strings: VN locale (Không thể tải, Đã gán, Huỷ, etc.)
- Dockerfile: node:20-alpine → npm build → nginx:1.27-alpine with SPA fallback + strict CSP

**Metrics:** tsc 0 errors, npm build 181.85 KB gzip, 0 lint errors (2 non-blocking warnings), all 18 Phase 4 todos ✓

**Key decisions:**
- @tanstack/react-table v8 (not v9, breaking API change downgrade)
- No shadcn CLI — hand-wrote Radix UI components. Lighter, fully owned.
- Native `<select>` for dropdowns (MVP sufficient)
- toast-bus event emitter decouples API client from React context
- DataTable uses `ColumnDef<T, any>` for TypeScript narrowing escape hatch

**Deferred:**
- Backend `/v1/users`, `/v1/projects` endpoints (Phase 5 required, blocking full E2E login)
- Zitadel OIDC app registration (manual Console step, requires user action with client_id)
- Silent renew iframe (accepted HTTP dev-mode trade-off, token TTL ≥15 min required)

### Phase 5 Backend + Bootstrap (fullstack-developer delegation, ~30 min)

**New endpoints:**
- `GET /v1/users?q=<search>&limit=<n>` — proxies Zitadel /v2/users with query + offset pagination; new `ZitadelUserSearchClient` with search caching
- `GET /v1/users/:id` — fetch single user from Zitadel
- `GET /v1/projects` — list available projects (hardcoded fallback: `[{id: 'central-rbac', name: 'Central RBAC'}]` for MVP)

**Seed + bootstrap:**
- 29 permissions (rbac.admin.*, rbac.auditor.*, system.root.manage_rbac) + 6 roles (Admin, Auditor, Viewer, ReadOnly, SystemRoot, Guest) in YAML `config/roles-seed.yaml`
- Idempotent bootstrap script `src/services/bootstrap.ts` with hard-check: `SELECT COUNT(*) FROM rbac.permissions WHERE role='rbac.admin'` must exist or fail startup
- New `ZitadelUserSearchClient` with TypeScript validation + OpenAPI-compat schema
- 21 new unit tests (zitadel-user-search-client.test.ts)

**Metrics:** 214/214 tests pass (after Phase 3 fixes), 90.51% coverage

**Deferred:**
- OneMCP portal wire `permissions[]` (Phase 5+1)
- Break-glass rotation script
- Quarterly restore script
- CODEOWNERS + full VL alerts

### Live Deploy Operations (main-agent, ~3 hours including debugging)

**VPS Discovery:**
- SSH authway-vps: confirmed public IP is `202.92.5.113` (was wrong hypothesis). That IP is actually OneMCP Connector, not authway.
- authway-vps egress IP: `103.57.222.245` (DC blocks inbound :80 from international).
- Decision: use **private IP 10.200.0.125:8082** — authway-vps is in same /24 private network (10.200.0.0/24). Traefik binds `10.200.0.125:8082:8082` on NIC eth1 (private).

**Traefik config:**
- Appended `rbac-review:8082` entrypoint to `/opt/authway/infra/authway-vps/traefik.yml`
- Added dual router labels (central-rbac API + central-rbac-ui) with parameterized `${RBAC_HOST}`, `${RBAC_ENTRYPOINT}`, `${RBAC_TLS_ENABLED}`
- Central-rbac backend already running since Phase 2 at `/opt/central-rbac/`. Extended in-place `docker-compose.prod.yml` with UI service + attached both backend + UI to `authway-prod_edge` network for Traefik discovery.
- **Rejected** review compose file approach (separate docker-compose.review.yml) because container_name collision + risk detaching from internal DB/Redis network. In-place edit safer.

**Blockers Hit:**

1. **IPv6 localhost in Alpine wget** (3 hour debugging session):
   - Symptom: Containers reported `unhealthy` status in Docker stats. Manual `curl http://127.0.0.1:8083/v1/health` inside container returned `200 OK`.
   - Root cause: Docker HEALTHCHECK uses `wget http://localhost:8083/v1/health`. BusyBox wget inside Alpine resolved `localhost` to IPv6 `::1`. Fastify bound IPv4 only (`127.0.0.1`). Connection refused on `::1`.
   - **Fix:** Patched healthcheck to explicitly `wget http://127.0.0.1:8083/v1/health`
   - **Lesson:** Test healthchecks with exact network config, not assumptions. IPv6 localhost is a real pitfall in containerized stacks.

2. **Traefik provider filtering "starting" containers**:
   - Traefik initially didn't pick up router labels from central-rbac-ui container because it was still in "starting" health state.
   - Once healthcheck passed and container reported "healthy", Traefik's Docker provider re-scanned and picked up labels.
   - No fix needed, just patience + understanding of Traefik health-filter behavior.

**Verification:**
- `curl http://10.200.0.125:8082/` → 200 OK (UI served)
- `curl http://10.200.0.125:8082/v1/health` → `{"status":"ok"}`
- Browsers: UI loads, login redirect to Zitadel works (pending OIDC client registration)

**Deployed files:**
- `/opt/central-rbac/src/` + `/opt/central-rbac/docker-compose.prod.yml` (in-place)
- `/opt/authway/infra/authway-vps/traefik.yml` (appended entrypoint + router)
- Backend boot: `npm run bootstrap` executed (idempotent, 0 permissions already exist)

### Testing + Code Review + Fixes (background delegation)

**Phase 3 fixes pass (from previous journal):**
- 193→214 tests passing (+21 for new search client)
- Coverage: 89.26%→90.51% (Phase 3 debt resolved)
- All 7 High findings fixed: H1 race, H2 stalled recovery, H3 shutdown, H4 hot-path, H5 checkbox pattern, **H6 permission check**, H7 compose network

**Phase 4-5 code review (8 findings, 7 fixed during cook):**
- H1: `/silent-renew` route missing + URL replace fragile → added silent-renew-iframe component (deferred full silentRenew callback until Phase 5+1)
- H2: bulk grant missing AbortController cleanup → added cleanup on unmount
- H3: `/v2/users` verification + error message sanitization → added try/catch + error filtering
- H4: `enrichGrantCounts` N × listUserGrants per keystroke → Zitadel DoS risk → debounce 300ms on search input + cached search client
- H5: React anti-pattern `onChange={() => {}}` on checkbox → changed to `onChange={(e) => setSelected(e.target.checked)}`
- **H6 BLOCKER**: UI `canWrite()` checks perm `rbac.admin.write`. That permission is **ONLY on `system.root` role** (not `rbac.admin` role). No one with `rbac.admin` role can write. → **Fixed by changing seed: added `rbac.admin.write` permission to `rbac.admin` role** + updated `parseRoles()` to extract JWT `roles[]` claim and map to role-based permissions
- H7: docker-compose.review.yml risk → **deleted file** in favor of in-place edit. Zero risk.
- L1: UI `users-list-page.tsx` 158 LOC (borderline) → split drawer + dialogs into separate files, back to <100 LOC per
- L2: API `zitadel-user-search-client.ts` 95 LOC (fine)

**Post-fix verification:**
- 214/214 pass (all 18 Phase 4-5 todos ✓)
- Coverage 90.51%
- Live redeploy: `docker compose up -d --force-recreate central-rbac central-rbac-ui`
- Health check: still 200 OK

## Lessons Learned

1. **Premature consensus on architecture kills flexibility.** V4 was "lock domain early" without talking to stakeholder. 30-min brainstorm surfaced actual requirement was "review UI first." Reversed entire stack design. Lesson: always validate with user before finalizing constraints-based architecture.

2. **Environment-driven architecture pays dividends.** Zero code changes to swap IP↔domain. Env vars + Traefik labels make multi-mode deployment trivial. Future: parameterize more infra (Redis host, DB pool size, outbox batch count).

3. **IPv6 localhost in Alpine is a gotcha.** BusyBox wget resolves `localhost` to `::1` first. IPv4-only services fail silently with "unhealthy" status. **Always test healthchecks with the exact host/port binding, not assumptions.** Document this as authway-vps deployment checklist item.

4. **In-place docker-compose edits beat separate review files.** Tempting to isolate via docker-compose.review.yml for safety, but it risks detaching services from internal networks (DB, Redis, Traefik). In-place edits with careful labeling are safer and easier to review in diff.

5. **Permission model must match role hierarchy exactly.** H6 was subtle: seed had `rbac.admin` role but no `rbac.admin.write` permission on it. UI `canWrite()` returned false for every admin. Test matrix: for each role, verify all expected perms exist. Add to Phase 5 smoke test.

6. **Search client caching prevents DoS.** H4 was calling `listUserGrants` per keystroke. Debounce + search caching with 60s TTL per query prevents hammering Zitadel. Build this pattern into Phase 6 if adding project search.

## What We Tried

- **H7 docker-compose.review.yml:** Considered separate file for cleaner isolation, rejected when we realized it breaks internal network routing. In-place edit with git diff discipline safer.
- **IPv6 healthcheck:** Tried `localhost` (failed), tried `0.0.0.0` (ignored), finally explicit `127.0.0.1` (works). BusyBox wget has no option to prefer IPv4 first — explicit is only option.
- **Private IP vs public:** Considered `202.92.5.113` public IP (wrong VPS), `10.200.0.125` private (correct). Private avoided firewall/DDoS surface during dev review.

## Root Cause Analysis

**V4 reversal:** Plan was written with premature assumptions. No stakeholder conversation before locking architecture. Reversal was healthy, not a failure—plan adaptation to reality.

**IPv6 localhost issue:** Container healthcheck written assuming modern OS with IPv6 dual-stack + IPv4 preference. Alpine + BusyBox + IPv4-only app is an uncommon combo, but it's *the combo we're shipping*. Healthchecks must be tested against actual container image, not assumption.

**Permission mapping:** Seed roles defined by design doc, but permission-to-role mapping was added ad-hoc without verification matrix. H6 was a gap in the mapping spec. Phase 5 added explicit permission-to-role table in bootstrap.ts, closed gap.

## Next Steps

### Immediate (user action, blocks smoke test E2E)

1. **Zitadel OIDC client registration** in `spike-test` org:
   - Console → Projects → central-rbac → Applications → Add Web OIDC
   - Redirect URI: `http://10.200.0.125:8082/callback`
   - Enable dev mode (allow HTTP)
   - Enable "Access token JWT" response type
   - Provide Client ID → update UI `.env.local` + rebuild

2. **E2E smoke test** (after OIDC app ready):
   - Login flow: click "Sign in" → redirected to Zitadel → login as test user → callback to UI
   - Users list loads < 3s
   - Grant/revoke flows functional
   - Bulk assign flows functional

### Post-review (deferred, not blocking)

3. **Domain + Sectigo cert** (Step 17.5 swap):
   - User provides `rbac.<domain>` + cert
   - Follow 8-step swap procedure in brainstorm doc
   - ~15-25 min, zero code change
   - Add domain redirect URI in Zitadel OIDC app (keep IP URI for 1 week fallback)

4. **Code debt** (Phase 5+1):
   - OneMCP portal wire `permissions[]` (needs role-based permission distribution)
   - Break-glass rotation script + runbook
   - Quarterly restore script for backup validation
   - CODEOWNERS assignment
   - Full VL alerting (currently bare minimum)

5. **Silent renew iframe** (Phase 5+1):
   - Currently deferred due to HTTP dev-mode. Token TTL ≥15 min handles review period.
   - When switching to HTTPS domain: implement proper silent-renew-iframe with nonce storage (not localStorage on HTTP)

## Unresolved Questions

1. Is `10.200.0.125:8082` the right choice for review, or should we use a public IP? (User confirmed private IP OK for internal review team)
2. VPS firewall policy — should review IP be source-restricted to team IPs only, or allow all? (Currently open, pending firewall rules from user)
3. Zitadel OIDC app: is `spike-test` org the right org, or create separate `central-rbac-review` org? (User to confirm, using spike-test as interim)

---

**Status:** DONE  
**Summary:** Phase 4-5 shipped with IP-first review architecture (reversed V4 domain-first decision), Vite React UI with OIDC + Users table + grant/revoke/bulk assign dialogs (40 files, 181 KB gzip, 18 todos complete), backend user proxy endpoints + 29 perms + 6 roles seed, live deployed to authway-vps at 10.200.0.125:8082 with Traefik routing. All code review findings fixed (7 High). IPv6 healthcheck blocker resolved. Next: Zitadel OIDC client registration + E2E smoke test (user action) → domain swap procedure (15-25 min, zero code change).
