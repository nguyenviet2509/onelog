# Phase 07 — Admin Single-Pane Wizard

## Context Links

- Brainstorm: `plans/reports/brainstorm-260826-1644-central-rbac-hardening-and-self-service.md` §3.1
- Research (Zitadel scope): `plans/reports/researcher-260826-1644-central-rbac-hardening-prereqs.md` Topic 1
- Predecessor plan (Phase 4 UI): `plans/260821-1644-central-rbac-single-pane/plan.md`
- Memory: `zitadel-jwt-verify-pitfalls.md`, `alertmanager-config-reload.md`

## Overview

- **Priority:** P1
- **Status:** pending (blocked by Phase 06 mTLS)
- **Duration:** 2 tuần
- **Brief:** Backend `POST /v1/admin/apps` proxy Zitadel `AddProject` + `AddOIDCApp` với sane defaults. Escalate central-rbac SA đến `IAM_OWNER` (accept per research, mitigate via rate-limit + audit). UI React 2-step wizard (form → preview → confirm). One-time reveal client_id/secret. New Apps list view.

## Key Insights

- **v4.16.1 KHÔNG có granular `PROJECT_CREATOR`** — must use `IAM_OWNER`; mitigate via rate-limit (5/day) + audit + alert threshold
- **Zitadel API breakage risk** — isolate calls behind adapter interface `zitadel-project.ts` for v5 migration
- **Client secret one-time reveal** — never store plaintext; log SHA256 hash for audit; UI shows once + copy-to-clipboard
- **Idempotency by name** — 409 Conflict if project name exists in Zitadel (query first, don't blindly create)
- **Alertmanager reload pitfall** (memory) — config changes require `docker compose restart alertmanager`, not SIGHUP
- Wizard covers common web OIDC case only; edge cases (SPA-only, machine account) fallback to Zitadel console + UI banner

## Requirements

### Functional

- FR-07.1: `POST /v1/admin/apps` accepts `{name, callback_urls[], app_type?, manifest_url?}` — validates schema (name kebab-case, slug regex `^[a-z][a-z0-9]{2,31}$`, callback_urls[] HTTPS, uniqueness, `manifest_url` optional HTTPS + public DNS). `manifest_url` persisted for Phase 08 sync (see Red Team Fix #15). Slug prefix-collision check: reject if new slug is prefix of, or has as prefix, any existing slug (case-insensitive).
- FR-07.2: Server calls Zitadel `AddProject` → `AddOIDCApp` with defaults (Auth Code + PKCE, access token 1h, refresh token 30d, RS256)
- FR-07.3: On success creates local role skeleton `{app}.viewer`, `{app}.editor`, `{app}.admin` in central-rbac DB
- FR-07.4: Returns `{project_id, client_id, client_secret}` ONCE; subsequent gets never return secret
- FR-07.5: Duplicate name (Zitadel or local) → 409 Conflict, no partial write
- FR-07.6: Rate-limit 5 attempted creates per admin per sliding 24h window (per JWT `sub`) — counts ALL attempts that reached Zitadel `AddProject` (any 2xx from Zitadel), not just successes (prevents bypass via forced validation-fail retries). Preview endpoint separately rate-limited 10/hour/admin. Global rate 20/day across all admins. See Red Team Fix #11.
- FR-07.7: Every attempt (success or fail) logs to `rbac.app_create_audit` (who, when, what, IP, result)
- FR-07.8: Alertmanager fires when >3 successful creates/day (anomaly signal)
- FR-07.9: UI wizard: Step 1 form (app name, redirect URIs, type dropdown) → Step 2 preview (defaults, warnings) → confirm → success screen with client_id + secret reveal + "I saved it" acknowledge button
- FR-07.10: UI Apps list page (`/admin/apps`) — table: name, created, client_id (masked), created_by; sort by created desc

### Non-functional

- NFR-07.1: Wizard completion (form submit → success screen) <3s p95
- NFR-07.2: Zitadel API adapter unit test coverage >80%
- NFR-07.3: Audit log write extends OneLog hash-chain (reuse existing migrations `003_audit_hash_chain.sql` + `004_audit_immutable_trigger.sql`) — each `rbac.app_create_audit` row includes prev_hash + current_hash; DENY UPDATE/DELETE on audit table at DB role level. Write MUST NOT block API response (async, but fsync before returning). See Red Team Fix #12.
- NFR-07.4: UI accessible via keyboard-only (WCAG AA basic)

## Architecture

### Component diagram

```
+------------------------------------------+
|  central-rbac-ui                         |
|  ┌────────────────────────────────────┐  |
|  │ AppsListPage  ← GET /v1/admin/apps │  |
|  │ NewAppWizardPage                   │  |
|  │  ├─ Step 1: NewAppFormStep         │  |
|  │  ├─ Step 2: NewAppPreviewStep      │  |
|  │  └─ Step 3: NewAppSuccessStep      │  |
|  │       (reveal client_id + secret)  │  |
|  └────────────────────────────────────┘  |
|                    │                     |
|                    ▼ POST /v1/admin/apps |
|                    │ (mTLS + admin JWT)  |
+--------------------┼---------------------+
                     │
+--------------------┼---------------------+
| central-rbac backend                     |
|  ┌────────────────────────────────────┐  |
|  │ routes/admin-apps.ts               │  |
|  │  ├─ validate body                  │  |
|  │  ├─ rate-limit-admin middleware    │  |
|  │  ├─ services/zitadel-project.ts    │  |
|  │  │    ├─ SearchProjects (idempot)  │  |
|  │  │    ├─ AddProject                │  |
|  │  │    └─ AddOIDCApp                │  |
|  │  ├─ create role skeleton (SQL tx)  │  |
|  │  └─ INSERT rbac.app_create_audit   │  |
|  └────────────────────────────────────┘  |
|                    │                     |
+--------------------┼---------------------+
                     ▼
              +------+-------+
              | Zitadel Mgmt |
              | API (IAM_OW) |
              +--------------+
                     │
                     ▼ audit stream
              +--------------+
              | Alertmanager |
              |  (>3/day)    |
              +--------------+
```

### Data flow (create app)

1. Admin navigates `/admin/apps/new` (must have JWT `role=admin`)
2. Fills form (Step 1) → client-side schema validate → POST /v1/admin/apps/preview (dry-run: validates + returns computed defaults)
3. Reviews preview (Step 2) → confirms
4. UI POST `/v1/admin/apps` with mTLS cert + admin JWT
5. Backend: rate-limit check → Zitadel `SearchProjects(name)` → 409 if exists
6. Zitadel `AddProject` (returns project_id) → `AddOIDCApp` (returns client_id + client_secret)
7. Local DB transaction: INSERT roles `{app}.viewer/.editor/.admin` + INSERT audit row
8. Response: `{project_id, client_id, client_secret}` (secret in memory only, hash logged)
9. UI Step 3: display + "I saved it" button → redirect `/admin/apps`
10. Alertmanager watches `rbac.app_create_audit` → fires if count/day > 3 for any admin

## Related Code Files

### Create

- `central-rbac/src/routes/admin-apps.ts` — POST /v1/admin/apps + POST /v1/admin/apps/preview + GET /v1/admin/apps
- `central-rbac/src/services/zitadel-project.ts` — adapter wrapping AddProject + AddOIDCApp + SearchProjects
- `central-rbac/src/services/role-skeleton-creator.ts` — DRY helper for viewer/editor/admin role creation
- `central-rbac/src/middleware/rate-limit-admin.ts` — 5/day per JWT sub, sliding window in DB
- `central-rbac/src/db/migrations/008_app_create_audit.sql` — table + indexes; **extends existing OneLog hash-chain (reuse `003_audit_hash_chain.sql` + `004_audit_immutable_trigger.sql`)** — every row has prev_hash + current_hash; DENY UPDATE/DELETE at DB role level. See Red Team Fix #12. (Numbering: 005/006/007 taken by predecessor outbox pattern.)
- `central-rbac/src/db/migrations/008a_pending_cleanups.sql` — durable orphan cleanup queue (`id, zitadel_project_id, admin_sub, error, retry_count, next_retry_at, created_at`) — Red Team Fix #8.
- `central-rbac/src/workers/orphan-cleanup-worker.ts` — background retry exp-backoff for `pending_cleanups`
- `central-rbac/src/lib/zitadel-defaults.ts` — sane OIDC app defaults (grant_types, token lifetimes)
- `central-rbac/tests/admin-apps.integration.test.ts` — 4 scenarios (happy, dup, rate-limit, zitadel-fail)
- `central-rbac-ui/src/pages/apps-list-page.tsx`
- `central-rbac-ui/src/pages/new-app-wizard-page.tsx`
- `central-rbac-ui/src/components/wizard-steps/new-app-form-step.tsx`
- `central-rbac-ui/src/components/wizard-steps/new-app-preview-step.tsx`
- `central-rbac-ui/src/components/wizard-steps/new-app-success-step.tsx`
- `central-rbac-ui/src/api/admin-apps-api.ts` — typed client
- `docs/deployment-onboard-app-wizard.md` — admin runbook + screenshots
- `alertmanager/rules/rbac-app-create-anomaly.yml` — Prometheus rule + Alertmanager route

### Modify

- `central-rbac/src/config.ts` — add `ZITADEL_MGMT_API_URL`, `ZITADEL_ADMIN_SA_JWT_PATH`
- `central-rbac/src/db/schema.ts` — reference new migration
- `central-rbac/src/app.ts` — register new routes
- `central-rbac-ui/src/App.tsx` (or router) — add `/admin/apps` + `/admin/apps/new` routes
- `central-rbac-ui/src/components/side-nav.tsx` — add "Apps" nav item
- Zitadel console: escalate `central-rbac-admin-sa` to `IAM_OWNER` (manual step, document in runbook)

### Delete

- None (additive phase)

## Implementation Steps

0.5. **Verify + commit audit hash-chain migrations (Validation Session 1)** — untracked `central-rbac/src/db/migrations/003_audit_hash_chain.sql` + `004_audit_immutable_trigger.sql` originate from predecessor plan 260821-1644 (verified via content = `rbac.audit_log` schema). Actions: (i) `git log --all -- <migration>` confirms never committed, (ii) review SQL for correctness (hash chain: `prev_hash + seq + payload → sha256`; immutable trigger: `BEFORE UPDATE OR DELETE ... RAISE EXCEPTION`), (iii) commit as first commit of Phase 07, (iv) verify chain extends cleanly to new `app_create_audit` (Step 2) + `manifest_sync_audit` (Phase 08 migration 006) via same `audit_log` table with `event_type` discriminator, OR separate hash-chained tables per type — pick based on 003 design.

1. **Zitadel SA setup + hardening** — via Zitadel console UI: locate `central-rbac-admin-sa` (NEW, different from Phase 06 SAs) → grant `IAM_OWNER`. Store client credentials at `/root/.secrets/zitadel-admin-sa.json` (0600, root-only). **Hardening (Red Team Fix #4):** (a) rotate MONTHLY (not quarterly), (b) Zitadel-side IP allowlist on SA = **authway-vps static /32** (e.g., `10.200.0.125/32` for internal calls; confirm with `ip addr show` before configuring — Validation Session 1 Decision), (c) file-integrity monitoring on `/root/.secrets/*.json` via inotify (systemd path unit) → alert on any read/write, (d) Zitadel-side audit alarm on any `AddProject` originating from non-central-rbac source IP (defense against direct SA JWT abuse if creds stolen). Document all 4 in `docs/deployment-onboard-app-wizard.md`. **Runbook**: VPS IP change (reboot/DHCP/provider) = update allowlist step in the doc.

    > **🔴 Red Team Fix #4 (Critical):** IAM_OWNER SA is high blast-radius. Rate-limit at central-rbac is bypassable if creds stolen (attacker calls Zitadel directly). Zitadel-side IP allowlist + audit alarm are the actual choke points.
2. **DB migration** — write `008_app_create_audit.sql`: columns `id, admin_sub, admin_ip, app_name, zitadel_project_id (nullable), client_id (nullable), result (enum: success/dup/zitadel_err/rate_limit/validation_err), error_msg (nullable), created_at`. Indexes on `admin_sub + created_at`, `created_at`.
3. **Zitadel adapter** — `zitadel-project.ts`: methods `searchProject(name)`, `addProject(name)`, `addOIDCApp(projectId, name, callbackUrls, defaults)`. Use `@zitadel/node` SDK if compatible with v4.16.1, else raw axios calls per Mgmt API docs. Adapter interface stable for v5 swap.
4. **Sane defaults module** — `zitadel-defaults.ts`: `{grantTypes: ["AUTHORIZATION_CODE", "REFRESH_TOKEN"], responseTypes: ["CODE"], authMethodType: "BASIC", accessTokenType: "JWT", accessTokenLifetime: "1h", refreshTokenLifetime: "30d", devMode: false}`.
5. **Rate-limit middleware** — sliding 24h window (NOT calendar-day). Query: `SELECT COUNT(*) FROM rbac.app_create_audit WHERE admin_sub=? AND result IN ('success','zitadel_err','dup') AND created_at > NOW() - INTERVAL '24 hours'` — counts ALL attempts that reached Zitadel (any 2xx), not just success (Fix #11 — prevents bypass via forced validation-fail retries). If ≥5 → 429. Separate preview rate-limit: 10/hour/admin (query `sync_type='preview'` in audit). Global rate check: 20/day across all admins. Recent-creates digest emailed to security channel every 4h.
6. **Route handler + durable orphan cleanup** — `admin-apps.ts POST /`: validate body (zod schema) → rate-limit → Zitadel SearchProjects (also query `pending_cleanups` — offer "reclaim orphan" flow to admin if match) → 409 if found → AddProject → AddOIDCApp → local tx (create 3 roles + audit row) → return. **On Zitadel failure mid-way (Red Team Fix #8):** attempt `RemoveProject`; if that ALSO fails → INSERT into `rbac.pending_cleanups` (project_id, admin_sub, error, created_at) — background worker retries with exp backoff. Wizard `SearchProjects` step queries this table on next admin session to offer reclaim.

    > **🔴 Red Team Fix #8 (High):** Best-effort rollback + weekly cron is inadequate. `pending_cleanups` durable queue + background retry + reclaim flow ensure no orphan project blocks wizard forever.
7. **Preview endpoint** — `POST /v1/admin/apps/preview`: same validation, returns computed defaults, no writes. Wizard uses this for Step 2.
8. **List endpoint** — `GET /v1/admin/apps`: paginated (limit 50), JOIN Zitadel SearchProjects if needed for enriched data; else read from local audit + Zitadel per-request (KISS: local audit is enough for MVP list).
9. **Integration tests** — 4 scenarios: (a) happy path, (b) duplicate name → 409, (c) rate limit hit → 429, (d) Zitadel API fails mid-transaction → audit row shows error + no orphan roles.
10. **UI wizard scaffold** — copy pattern from predecessor Phase 4 grant/revoke dialog. `new-app-wizard-page.tsx` = state machine (step 1/2/3), memoized form state.
11. **Step 1 form** — react-hook-form + zod schema: `name` (kebab-case, slug regex `^[a-z][a-z0-9]{2,31}$`), `callback_urls` (array of HTTPS URLs, at least 1), `app_type` (dropdown: `web-oidc` default; disabled `spa`, `machine` with tooltip "Advanced: use Zitadel console"), **`manifest_url` (OPTIONAL, HTTPS + public DNS, defaults to `{callback_urls[0].origin}/.well-known/rbac-permissions.json`)** — persisted for Phase 08 sync. See Red Team Fix #15. Client-side slug prefix-collision check via GET `/v1/admin/apps?slug-prefix=<slug>` before submit.
12. **Step 2 preview** — GET `/v1/admin/apps/preview` on step transition. Show table of defaults + warning banner "Client secret will be shown once. Save it immediately."
13. **Step 3 success** — display project_id, client_id, client_secret in monospace + copy-to-clipboard buttons. Big yellow "I saved it" button (disabled 5s to force reading). Click → redirect `/admin/apps`.
14. **Apps list page** — table with search, pagination, click row → project detail (out of scope, placeholder link).
15. **Nav integration** — side-nav "Apps" item visible only if user has `admin` role.
16. **Alertmanager rule** — Prometheus query `sum by (admin_sub) (rate(rbac_app_create_success_total[1d])) > 3` (assuming metrics endpoint exposes counter from audit table). Route to onelog Telegram channel per `alert-triage-noise-reduction` conventions.
17. **Metrics endpoint** — expose `/metrics` counter `rbac_app_create_success_total{admin_sub="..."}` — incremented on success in route handler.
18. **Lab test** — deploy to onelog-source (one-way sync policy). Manual walkthrough: create test app "wizard-lab-test", verify Zitadel console shows project + OIDC app, central-rbac shows 3 roles + audit row.
19. **Prod deploy** — commit local → push → SSH authway-vps → git pull → docker compose up -d rbac-api rbac-ui alertmanager → verify. Per `host-sync-policy.md`.
20. **Prod smoke** — create synthetic app end-to-end (name `wizard-prod-smoke-YYMMDD`). Time from click "New App" → success screen ≤5min. Confirm audit row + hash-chain valid + alert didn't fire (<3/day). Adopter #2 true validation deferred to follow-up plan (Decision A).

## Todo List

- [ ] 1. Zitadel SA setup + hardening (IAM_OWNER + monthly rotate + IP allowlist + inotify + Zitadel audit alarm)
- [ ] 2. DB migration `008_app_create_audit.sql` (extends hash-chain 003/004)
- [ ] 2a. DB migration `008a_pending_cleanups.sql` + orphan cleanup worker
- [ ] 3. Zitadel adapter `zitadel-project.ts`
- [ ] 4. Defaults module `zitadel-defaults.ts`
- [ ] 5. Rate-limit middleware (5/24h sliding, all attempts count; preview 10/hr; global 20/day)
- [ ] 6. Route handler POST /v1/admin/apps (+ pending_cleanups on rollback fail + reclaim flow)
- [ ] 7. Preview endpoint (dry-run, rate-limited)
- [ ] 8. List endpoint GET /v1/admin/apps
- [ ] 9. Integration tests (4 scenarios)
- [ ] 10. Wizard page scaffold + state machine
- [ ] 11. Step 1 form + zod validation (slug regex + prefix-collision + manifest_url field)
- [ ] 12. Step 2 preview with warning banner
- [ ] 13. Step 3 success reveal + acknowledge
- [ ] 14. Apps list page
- [ ] 15. Side-nav integration (role-gated)
- [ ] 16. Alertmanager rule + Prometheus counter
- [ ] 17. Metrics endpoint counter increment
- [ ] 18. Lab test end-to-end
- [ ] 19. Prod deploy authway-vps
- [ ] 20. Prod smoke test with synthetic app end-to-end <5min (adopter #2 deferred — Decision A)

## Success Criteria

- **Synthetic app end-to-end registered <5 min** via wizard without dev support (measured via screencast) — Decision A: adopter #2 deferred, use synthetic
- Zitadel console shows project + OIDC app matching wizard input
- central-rbac DB shows 3 roles + audit row within 1s of success; audit row has valid hash-chain link (prev_hash matches predecessor row's current_hash)
- Client secret displayed exactly once; refreshing success page shows redacted placeholder
- 6th create in 24h returns 429 with clear error message (sliding window, all attempts count)
- Alertmanager fires test alert on synthetic 4th create/day in staging
- No orphan Zitadel projects wedge wizard 409-forever — chaos test: kill process mid-flow, verify `pending_cleanups` row created and background worker retries
- IAM_OWNER SA IP allowlist blocks direct Zitadel call from non-central-rbac IP (verified via curl from lab host)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Zitadel SA compromise → mass project creation | Low | Critical | Rate-limit (5/24h sliding, all attempts); audit every attempt (hash-chained); alert >3/day; SA creds 0600; **monthly rotation** (was quarterly); **Zitadel-side IP allowlist** on SA (only central-rbac egress IP); **Zitadel-side audit alarm** on AddProject from non-central-rbac IP; inotify file-integrity on `/root/.secrets/*`. See Red Team Fix #4. |
| Zitadel v4→v5 API break | Medium | Medium | Adapter interface isolation; smoke test on Zitadel upgrade; CI job runs against Zitadel next-version container |
| Local tx succeeds, Zitadel rollback fails → orphan project blocks wizard 409-forever | Medium | Medium | `pending_cleanups` durable queue + background exp-backoff worker + "reclaim orphan" flow in SearchProjects step (Red Team Fix #8); weekly reconciliation cron as fallback |
| Admin sees client_secret leaked in browser history / screenshot | High | High | UI: reveal button (initially masked); auto-copy-to-clipboard; warn banner; 5s delay before acknowledge; audit acknowledge event |
| Rate-limit bypass via multiple admin accounts | Low | Medium | Also enforce global rate: 20/day across all admins; alert on global anomaly |
| Wizard defaults wrong for adopter → broken OIDC flow | Medium | High | Document defaults in runbook; provide "advanced" link to Zitadel console for edit post-create |

## Security Considerations

- Client secret NEVER written to log (only SHA256 hash for audit correlation)
- **Rate-limit counts ALL attempts reaching Zitadel `AddProject` (any 2xx)**, not just success (Fix #11) — prevents bypass via forced validation-fail retries. Sliding 24h window, not calendar-day. Preview endpoint rate-limited 10/hour/admin (was previously unlimited). Global rate 20/day across all admins.
- Audit row inserted BEFORE Zitadel call (state=`attempted`) then UPDATE on result → survives crash mid-flow. **Row extends OneLog hash-chain (migrations 003/004 reused)**; DENY UPDATE/DELETE at DB role level; row immutable post-write (Fix #12).
- Zitadel SA JWT bearer only for backend → NEVER forwarded to browser
- **IAM_OWNER SA hardening (Fix #4):** monthly rotation, Zitadel-side IP allowlist (central-rbac egress IP only), inotify file-integrity on `/root/.secrets/*.json`, Zitadel-side audit alarm on `AddProject` from non-central-rbac IP
- UI enforces admin role via JWT claim before rendering wizard; backend re-validates (defense in depth)
- Callback URL validation: reject `http://` except `http://localhost` (dev fallback, flag env-gated off in prod)
- `manifest_url` validated HTTPS + public DNS at wizard time (Fix #15) — persisted for Phase 08 fetcher (SSRF guards applied there — see Phase 08 Fix #2)
- Slug format enforced `^[a-z][a-z0-9]{2,31}$` + prefix-collision check (case-insensitive) — see Phase 08 Fix #13

## Rollback Plan

- **Wizard bug creates broken apps** → disable UI route (feature flag env `ADMIN_WIZARD_ENABLED=false` → hide nav + return 503 from backend route)
- **Zitadel SA leak suspected** → immediately revoke SA in Zitadel console → wizard breaks with 401 → recreate SA + redeploy
- **DB migration bug** → migration is additive (new table only); rollback = `DROP TABLE rbac.app_create_audit` + revert code deploy
- **Rate-limit too restrictive** → tune env `ADMIN_APP_CREATE_RATE_LIMIT=10` without code change
- **Orphan Zitadel projects** → manual cleanup script `scripts/cleanup-orphan-projects.ts` (dry-run mode required)

## Next Steps (dependencies for Phase 08)

- Phase 08 manifest sync operates on apps CREATED via wizard OR pre-existing → wizard MUST populate `app_id` field consistently with manifest namespace enforcement
- Phase 08 needs `/v1/admin/apps/:id/sync-manifest` route → wire under same admin auth + rate-limit patterns established here
- Phase 07 UI Apps list will get "Sync manifest" button per row in Phase 08
