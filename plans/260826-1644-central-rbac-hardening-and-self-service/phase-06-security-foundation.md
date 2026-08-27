# Phase 06 — Security Foundation

## Context Links

- Brainstorm: `plans/reports/brainstorm-260826-1644-central-rbac-hardening-and-self-service.md` §3.2, §4
- Research (prereqs): `plans/reports/researcher-260826-1644-central-rbac-hardening-prereqs.md` Topic 2 (step-ca), Topic 3 (single-DC)
- Research (mTLS): `plans/reports/researcher-260826-1644-central-rbac-mtls-and-manifest.md` Topic 1
- Predecessor plan (Phase 04 auth middleware): `plans/260821-1644-central-rbac-single-pane/plan.md`
- Related: `plans/260821-1443-authway-security-hardening/plan.md` (Zitadel TLS overlap)
- Memory: `zitadel-jwt-verify-pitfalls.md`, `vl-cross-vps-binding.md`

## Overview

- **Priority:** P1 (blocker for Phase 07/08)
- **Status:** pending
- **Duration:** 2 tuần
- **Brief:** Bỏ shared secret `X-Rbac-Token`, thay bằng Zitadel SA JWT (JWKS verify). Deploy step-ca sidecar issue client certs. Traefik v3 enforce mTLS trên `/v1/resolve` + `/v1/admin/*` với `RequireAndVerifyClientCert`. HTTPS termination bằng Sectigo cert (chờ user cấp). Runbook rotate 90-day + daily expiry check.

## Key Insights

- **Zitadel v4.16.1 NO granular PROJECT_CREATOR** — mitigation for SA scope moves to Phase 07 (IAM_OWNER + rate-limit + audit)
- **step-ca chosen over Vault** — 30-min setup, native ACME, single Go binary; Vault deferred
- **Single-DC provider LAN (10.200.0.0/24)** — mTLS sufficient, skip Wireguard
- **Traefik v3 `clientAuth` = TLS-Option-scoped, NOT per-router** — must use 2 TLS options (strict-mtls, mtls-optional) on same hostname; router selects via `tls.options=strict-mtls@file`
- **Client cert subject → header injection = NOT native** — implement custom middleware or forwardauth sidecar to add `X-Client-Cert-CN`
- **CRL/OCSP not built-in Traefik** — rely on short cert lifetime (90d) + manual revoke via CA bundle regeneration
- **BusyBox healthcheck IPv6 pitfall** (memory) — bind explicit 127.0.0.1 in step-ca healthcheck

## Requirements

### Functional

- FR-06.1: All central-rbac endpoints reject requests with `X-Rbac-Token` (removed middleware path)
- FR-06.2: `/v1/resolve` + `/v1/admin/*` verify Zitadel SA JWT (JWKS-based) + require client mTLS cert
- FR-06.3: `/webhooks/pre-token` + `/health` accept unauthenticated / no client cert (Zitadel calls this, no mTLS)
- FR-06.4: step-ca sidecar issues client certs for 3 SAs: `central-rbac-webhook`, `onemcp-backend`, `portal-admin`
- FR-06.5: Backend validates HMAC-signed `X-Client-Cert-CN` header (Traefik plugin signs with rotating secret; backend rejects if signature invalid or missing). Header value's CN then matches JWT `sub` claim (defense-in-depth double-check). See Red Team Fix #3.
- FR-06.6: HTTPS termination via step-ca-issued interim server cert (`rbac.<internal-domain>`); Sectigo swap runbook (Step 10a) executed when external cert delivered
- FR-06.7: Daily cron `check-cert-expiry.sh` alerts 60 days before any cert expires (leaf + intermediate CA), writes heartbeat timestamp to node_textfile — Prometheus alerts if heartbeat stale >2 days. Direct Telegram fallback via curl bot API if Alertmanager unreachable. See Red Team Fix #7.

### Non-functional

- NFR-06.1: Cert rotation = zero downtime (issue new cert → distribute → docker restart affected consumer only)
- NFR-06.2: mTLS handshake latency <50ms p99 (single-DC LAN)
- NFR-06.3: step-ca container <200MB memory footprint
- NFR-06.4: Runbook <15min to issue new client cert (documented)

## Architecture

> **🔴 Red Team Fix #3 (Critical):** mTLS CN header trust boundary — Traefik ingress strips inbound `X-Client-Cert-*` headers BEFORE middleware injects them (prevents client spoofing). Middleware signs injected `X-Client-Cert-CN` with HMAC secret rotated weekly; backend rejects unsigned/invalid-sig headers. central-rbac backend binds only to Traefik docker network — refuses direct TCP from other sources (docker network isolation). Auth chain default-applied globally with explicit opt-out per route (not opt-in).

### Component diagram

```
+---------------------------+
| authway-vps (10.200.0.125)|
|                           |
|  +---------------------+  |
|  |  Traefik v3         |  |
|  |  ┌─────────────────┐|  |
|  |  │ TLS Options:    ││  |
|  |  │  strict-mtls    ││  |    Sectigo server cert
|  |  │  mtls-optional  ││<─────  (HTTPS termination)
|  |  └─────────────────┘|  |
|  |    │        │       |  |
|  |    │strict  │opt    |  |
|  |    ▼        ▼       |  |
|  |  /v1/*   /webhook/* |  |
|  |  /admin  /health    |  |
|  |    │                |  |
|  |    │ + X-Client-Cert-CN header (via middleware) |
|  |    ▼                |  |
|  |  central-rbac       |  |
|  |  ┌──────────────┐   |  |
|  |  │auth-mtls +   │   |  |
|  |  │auth-jwt      │   |  |
|  |  │(double-check)│   |  |
|  |  └──────────────┘   |  |
|  |                     |  |
|  |  step-ca (sidecar)  |  |
|  |  ├── root (offline) |  |
|  |  ├── intermediate   |  |
|  |  └── ACME endpoint  |  |
|  +---------------------+  |
+---------------------------+
         ▲       ▲
         │ mTLS  │ mTLS + JWT
         │       │
    +----+---+  +---+------------+
    |onemcp- |  |onelog-vps      |
    |backend |  |(portal-admin)  |
    |cert    |  |cert            |
    +--------+  +----------------+
```

### Data flow (resolve request)

1. Consumer (e.g., onemcp-backend) obtains Zitadel SA JWT (client credentials flow)
2. Consumer TLS handshake with Traefik — presents client cert issued by step-ca intermediate
3. Traefik `strict-mtls` TLS option validates client cert against CA bundle
4. Traefik middleware extracts cert Subject CN → inject `X-Client-Cert-CN: onemcp-backend-sa`
5. Traefik routes to central-rbac backend
6. `auth-mtls` middleware confirms `X-Client-Cert-CN` present (proves passed Traefik mTLS)
7. `auth-jwt` middleware verifies JWT via JWKS, extracts `sub`
8. Cross-check: `sub` claim MUST match `X-Client-Cert-CN` → else 403
9. Handler processes request

## Related Code Files

### Create

- `central-rbac/src/middleware/auth-mtls.ts` — verify `X-Client-Cert-CN` header presence
- `central-rbac/src/middleware/auth-cert-jwt-crosscheck.ts` — verify JWT sub === cert CN
- `authway/infra/authway-vps/step-ca/ca.json` — step-ca config (provisioners, cert lifetimes)
- `authway/infra/authway-vps/step-ca/README.md` — bootstrap SOP (root offline, intermediate on-disk)
- `authway/infra/authway-vps/traefik/dynamic/tls-options.yml` — strict-mtls + mtls-optional
- `authway/infra/authway-vps/traefik/dynamic/middleware-cert-header.yml` — cert-subject → header
- `authway/infra/authway-vps/scripts/issue-client-cert.sh` — wrap `step ca certificate`
- `authway/infra/authway-vps/scripts/check-cert-expiry.sh` — cron 30-day alert
- `authway/infra/authway-vps/scripts/rotate-client-cert.sh` — rotate + distribute + restart consumer
- `docs/deployment-central-rbac-mtls.md` — runbook (bootstrap, issue, rotate, revoke)

### Modify

- `authway/infra/authway-vps/docker-compose.yml` — add `step-ca` service (pinned image digest per Step 0 PoC, volume for root/intermediate, exposed only on 10.200.0.0/24) with `healthcheck: step ca health`. Traefik + central-rbac add `depends_on: step-ca: {condition: service_healthy}`. Traefik image version pinned explicitly. See Red Team Fix #10.
- `central-rbac/src/middleware/auth-jwt.ts` — remove `X-Rbac-Token` path, tighten SA claim validation (require `aud`, `iss`, `exp`, `sub` present)
- `central-rbac/src/routes/index.ts` — apply `auth-mtls` + `auth-jwt` + crosscheck on `/v1/resolve` + `/v1/admin/*`
- `central-rbac/src/config.ts` — remove `RBAC_SHARED_SECRET` env, add `MTLS_TRUSTED_CA_PATH`
- `docker-compose.yml` (central-rbac stack) — mount step-ca CA bundle read-only

### Delete

- `.env.central-rbac` line `RBAC_SHARED_SECRET=...` (all deployments)
- `central-rbac/src/middleware/auth-shared-secret.ts` (if exists as standalone)

## Implementation Steps

> **🔴 Red Team Fix #5 (Critical):** Step 0 gates the whole phase. If PoC fails, escalate to user for Vault fallback decision — do NOT proceed to Step 1.

0. **step-ca PoC gate (1-day timeboxed, on onelog-source lab)** — validate step-ca claims before committing to phase. Deliverables: (a) pinned image digest documented (not `:latest`), (b) non-interactive `step ca init` script (no TTY prompts), (c) working `openssl s_client -connect ... -cert client.pem -key client.key` handshake against Traefik with client cert. Gate: only proceed to Step 1 if all 3 deliverables verified. If any fails → escalate for Vault fallback.

1. **Prereq audit** — grep all repos for `X-Rbac-Token` + `RBAC_SHARED_SECRET`. Document every consumer that will need SA credentials. File: `plans/reports/audit-shared-secret-usage-260826.md`
2. **Zitadel SA provisioning** — via Zitadel console, create 3 SAs: `central-rbac-webhook`, `onemcp-backend`, `portal-admin`. Each gets client credentials JSON. Store in 1Password / VPS `/root/.secrets/` (0600).
3. **Update `auth-jwt.ts` (DUAL-AUTH mode)** — enforce required claims (`iss` = Zitadel issuer, `aud` = central-rbac audience, `exp` valid). **KEEP `X-Rbac-Token` fallback branch during rollout** — supports BOTH shared-secret AND mTLS+JWT concurrently until Step 15.5. See Red Team Fix #1.

    > **🔴 Red Team Fix #1 (Critical):** Backend supports BOTH auth paths concurrently during rollout to avoid auth-bypass window when shared secret deleted before all consumers migrated. Shared-secret code path only removed in Step 15.5 (after 48h verification all consumers on mTLS).

4. **Deploy step-ca sidecar (dev-mode first on onelog-source lab)** — pull step-ca image at pinned digest (from Step 0 PoC), run non-interactive init script, extract root cert offline, generate intermediate. Bind to 10.200.0.125:9000 only. Add `healthcheck: step ca health` to compose.
    <!-- Updated: Validation Session 1 — CA root key Age-encrypted -->
    **Root key backup (Validation Session 1 Decision):** After init, encrypt `intermediate_ca_key` + `root_ca_key` với `age -R backup-age.pub` → save to Bitwarden + QR paper (reuse OneLog `backup-age.pub` pattern). Never leave root key on VPS unencrypted after intermediate generated. Runbook step in `docs/deployment-central-rbac-mtls.md`.
5. **Test cert issuance on lab** — `step ca certificate central-rbac-webhook cert.pem key.pem --provisioner=admin --provisioner-password-file=/tmp/pass`. Verify cert chain: `openssl verify -CAfile root.pem -untrusted intermediate.pem cert.pem`.
6. **Traefik TLS options** — write `tls-options.yml` with `strict-mtls` (RequireAndVerifyClientCert, caFiles=intermediate.pem) + `mtls-optional` (NoClientCert). Reload Traefik. Smoke test on lab.

    > **🔴 Red Team Fix #6 (Critical):** Same-hostname 2-TLS-options pattern is unverified in Traefik v3 — Step 6a spike below MUST pass before Step 7. Fallback: split hostnames if pattern breaks.

6a. **Traefik 2-TLS-options verification spike** — matrix test on lab, 4 curl variants against same hostname: (i) webhook path w/o cert, (ii) webhook path w/ cert, (iii) resolve path w/o cert, (iv) resolve path w/ cert. Expected: (i,ii) both 200 (mtls-optional); (iii) TLS handshake fail; (iv) 200. **If pattern fails** → split hostnames: `rbac-webhook.<domain>` (open) + `rbac-internal.<domain>` (strict-mtls). Add DNS + Traefik router changes to Step 6 accordingly. Pin Traefik image version explicitly in compose file.

7. **Client cert header middleware (with anti-spoof HMAC)** — evaluate 2 approaches: (a) Traefik plugin, (b) forwardauth sidecar. Decide + implement in `middleware-cert-header.yml`. **MUST also**: (i) `headers.customRequestHeaders` explicit-empty for `X-Client-Cert-*` on ingress to strip client-supplied values BEFORE middleware sets header, (ii) middleware signs injected header with HMAC secret shared to backend (rotating weekly). Test: `curl --cert client.pem --key client.key` returns 200; `curl -H "X-Client-Cert-CN: spoof"` (no cert) returns 401 (stripped + backend rejects unsigned).
    <!-- Updated: Validation Session 1 — HMAC secret via docker secret + weekly rotate -->
    **HMAC secret storage (Validation Session 1 Decision):** Store as `docker secret cert_hmac_v{N}` (compose v3.7+); mount 0400 in Traefik + backend containers at `/run/secrets/cert_hmac`. Rotation: weekly cron `rotate-cert-hmac.sh` gens new secret via `openssl rand -hex 32`, creates `cert_hmac_v{N+1}`, updates compose to reference new secret, rolling-restart Traefik → backend (5-10 min overlap window where both v{N} and v{N+1} accepted). Delete v{N} after 24h grace. Runbook in `docs/deployment-central-rbac-mtls.md`.
8. **Backend middleware chain (default-applied globally)** — implement `auth-mtls.ts` (checks HMAC-signed header + verifies signature), `auth-cert-jwt-crosscheck.ts` (cert CN === JWT sub). Apply GLOBALLY as default to all routes with EXPLICIT opt-out on `/webhooks/pre-token` + `/health` (not opt-in — Fix #3). Bind backend to Traefik docker network only.
9. **Integration test lab** — smoke script: (a) request `/v1/resolve` WITHOUT cert → expect 401 TLS, (b) with cert but wrong JWT → 403, (c) cert CN mismatches JWT sub → 403, (d) valid cert + valid JWT + match → 200, (e) header-spoof (no cert, forged `X-Client-Cert-CN`) → 401.
10. **HTTPS termination — interim step-ca-issued server cert** — issue server cert for `rbac.<internal-domain>` via step-ca; wire into Traefik. Add step-ca root CA to admin browser OS trust store (documented in runbook). Enables Phase 07/08 without external Sectigo dep. See Decision B.
10a. **Sectigo swap runbook** — when Sectigo cert arrives: (i) replace step-ca-issued cert path in Traefik config, (ii) verify no cert-pinning in consumers breaks (grep for pinned SPKI/thumbprint), (iii) remove step-ca root from browser trust stores (browsers now trust Sectigo chain natively), (iv) hot-reload Traefik. Runbook lives in `docs/deployment-central-rbac-mtls.md`.
11. **Cert rotation runbook** — write `docs/deployment-central-rbac-mtls.md` covering: bootstrap CA, issue new SA cert, distribute (scp/rsync + docker restart consumer), revoke (regenerate CA bundle + Traefik reload), emergency rollback, Sectigo swap (Step 10a).

    > **🔴 Red Team Fix #7 (Critical):** Cron SPOF mitigated via heartbeat + Prometheus staleness alert + Telegram fallback + 60d threshold + intermediate CA check.

12. **Daily expiry check cron** — `check-cert-expiry.sh` iterates all issued certs (leaf + intermediate CA), `openssl x509 -enddate`, alerts via Alertmanager webhook if <60 days. Cron writes `/var/lib/node_exporter/textfile/cert_check_last_success` timestamp. Prometheus alert: `time() - cert_check_last_success > 172800` (2 days stale = cron silently died). Direct Telegram fallback (curl bot API) if Alertmanager unreachable (5s health probe). Cron at 06:00 daily. **When adding Alertmanager rule: `docker compose restart alertmanager`, NOT SIGHUP** (per memory `alertmanager-config-reload.md`).
12.5. **Freeze tag before backend deploy** — `git tag pre-phase06-freeze` on local + push. Used as rollback anchor for Step 15.5 shared-secret removal.
13. **Prod deploy (authway-vps)** — commit local → push origin/master → SSH VPS `git pull` → `docker compose up -d step-ca` (verify healthcheck passes) → `docker compose up -d traefik central-rbac` (which now depend on healthy step-ca) → verify `git status` clean. Per `host-sync-policy.md`. Post-reboot smoke test added to runbook.
14. **Prod smoke test** — repeat step 9 tests (5 scenarios) against prod domain. Document results.
15. **Consumer rollout (dual-auth active)** — issue certs for 3 SAs → distribute → restart consumers (onemcp-backend, portal-admin, central-rbac-webhook itself). Rolling, one at a time. Consumers migrate from `X-Rbac-Token` to mTLS+JWT; backend accepts both during this window.
15.5. **Shared-secret removal (48h after Step 15 completion)** — verify Prometheus counter `rbac_auth_shared_secret_hits_total == 0` for 48h → remove `X-Rbac-Token` code branch from `auth-jwt.ts` → delete `RBAC_SHARED_SECRET` from all `.env` files → redeploy. **Delete `MTLS_ENFORCE=false` env entirely** — no naked bypass. Emergency break-glass = manual git revert to `pre-phase06-freeze` tag + Shamir-split 2-admin approval (documented as 15-min auto-expire in runbook). See Red Team Fix #1.
16. **Post-deploy audit** — grep prod logs for any `X-Rbac-Token` hit → should be zero. Confirm env var absent. Commit.

## Todo List

- [ ] 0. step-ca PoC gate (1-day, lab; blocks phase if fails)
- [ ] 1. Audit shared secret usage across repos (report)
- [ ] 2. Provision 3 Zitadel SAs + secure client credentials
- [ ] 3. Harden `auth-jwt.ts` — dual-auth mode (keep X-Rbac-Token during rollout)
- [ ] 4. Deploy step-ca sidecar on onelog-source lab (pinned digest + healthcheck)
- [ ] 5. Test cert issuance chain (openssl verify)
- [ ] 6. Configure Traefik TLS options (strict-mtls + mtls-optional)
- [ ] 6a. Traefik 2-TLS-options verification spike (4-curl matrix; fallback = split hostnames)
- [ ] 7. Implement client cert → HMAC-signed header middleware (strip inbound + sign)
- [ ] 8. Implement backend `auth-mtls` (verify HMAC sig) + crosscheck; global default-applied
- [ ] 9. Lab integration test (5 scenarios pass, incl. spoof rejection)
- [ ] 10. HTTPS termination via step-ca interim server cert (rbac.<internal-domain>)
- [ ] 10a. Sectigo swap runbook documented (executes on cert arrival)
- [ ] 11. Write rotation runbook `docs/deployment-central-rbac-mtls.md`
- [ ] 12. Deploy daily cert expiry check cron (60d threshold + heartbeat + Telegram fallback)
- [ ] 12.5. Create `pre-phase06-freeze` git tag as rollback anchor
- [ ] 13. Prod deploy authway-vps (step-ca first, healthcheck-gated startup)
- [ ] 14. Prod smoke test 5 scenarios
- [ ] 15. Rollout consumers (3 SAs, dual-auth active, one at a time)
- [ ] 15.5. Remove shared-secret code path (48h after Step 15; delete MTLS_ENFORCE env)
- [ ] 16. Post-deploy audit + verify env vars absent

## Success Criteria

- Grep prod logs shows zero `X-Rbac-Token` header hits over 7 consecutive days
- `/v1/resolve` without valid mTLS cert returns TLS handshake failure (curl `error:0A00045C`)
- `/v1/resolve` with valid cert + wrong JWT returns 403 with body `{error: "jwt_verify_failed"}`
- `/v1/resolve` with mismatched cert CN vs JWT sub returns 403 with body `{error: "cert_jwt_mismatch"}`
- Cert rotation E2E runbook executed successfully on lab (issue → distribute → verify → revoke)
- `check-cert-expiry.sh` fires test alert when synthetic cert with 20-day expiry is added

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| step-ca root CA leak → attacker mints any client cert | Low | Critical | Root stored offline (encrypted, printed cold copy); only intermediate hot |
| Client cert leak → mTLS bypass | Medium | High | 90d rotation; log per-cert access via Traefik AccessLog; revocation runbook tested |
| Traefik TLS option misconfig → all routes open | Medium | Critical | Lab test all 4 scenarios before prod; smoke test post-deploy; alert on 401/403 rate drop |
| Sectigo cert delay blocks Phase 07/08 | Medium | Medium | Interim step-ca-issued server cert (`rbac.<internal-domain>`) unblocks Phase 07/08; Sectigo swap runbook (Step 10a) executed later. See Decision B. |
| Rotate script bug wipes consumer cert mid-request | Low | High | Runbook mandates dual-cert grace window (new cert deployed, old still valid until next rotate) |
| Backend `auth-mtls` false-negative → legitimate calls 403 | Medium | High | Dual-auth mode (Steps 3-15) accepts BOTH shared-secret AND mTLS+JWT during rollout; shared-secret path removed only in Step 15.5 after 48h clean metrics. NO `MTLS_ENFORCE=false` naked bypass — emergency rollback = revert to `pre-phase06-freeze` tag with 2-admin approval. |
| step-ca PoC fails (Step 0) | Medium | High | Timeboxed 1 day; if fails, escalate for Vault fallback decision — do not proceed to Step 1 |
| Traefik 2-TLS-options pattern breaks (Step 6a) | Medium | Medium | Fallback: split hostnames `rbac-webhook.<domain>` + `rbac-internal.<domain>` — DNS + router changes ready |
| Cert expiry cron silently dies (weekend outage) | Medium | High | Heartbeat file + Prometheus staleness alert (>2d) + direct Telegram fallback + 60d threshold |
| step-ca healthcheck fails post-reboot → Traefik loads without CA | Low | Critical | `depends_on: step-ca: {condition: service_healthy}`; Traefik `restart: on-failure`; post-reboot smoke in runbook |

## Security Considerations

- Root CA stored offline (encrypted USB + printed backup); only intermediate CA on-disk in step-ca sidecar
- step-ca provisioner password stored in `/root/.secrets/step-ca-provisioner-pass` (0600, root only)
- Client cert private keys never leave issuing consumer VPS; use SCP over SSH (public key auth only)
- Traefik AccessLog captures client cert Subject on every request → tail-forward to Vector for audit
- Zitadel SA client credentials JSON stored at `/root/.secrets/sa-{name}.json` (0600); NEVER in git
- **NO `MTLS_ENFORCE=false` env** — was previously a naked bypass. Removed. Emergency = revert to `pre-phase06-freeze` git tag + Shamir-split 2-admin approval; break-glass session auto-expires 15min; every use pages security channel immediately. See Red Team Fix #1.
- **Header anti-spoof (Fix #3):** Traefik ingress strips inbound `X-Client-Cert-*`; middleware signs injected header with rotating HMAC secret (weekly rotate); backend rejects if signature invalid. central-rbac binds only to Traefik docker network — direct TCP from other containers refused. Auth chain default-applied globally with explicit opt-out.
- **Cert expiry monitoring (Fix #7):** heartbeat file + Prometheus staleness alert (>2d) + direct Telegram fallback bypass Alertmanager if unreachable; 60d threshold covers weekend/holiday buffer; intermediate CA expiry checked alongside leaves.
- No CRL/OCSP: revocation = regenerate intermediate CA bundle (Traefik `caFiles` reload) + all consumers re-issue (72h SLA in runbook)

## Rollback Plan

- **Backend middleware bug (false 403s) — during dual-auth window (Steps 3-15)** → consumers still authenticate via `X-Rbac-Token` fallback; investigate + fix without emergency. No naked bypass env.
- **Backend middleware bug — after Step 15.5 (shared-secret removed)** → revert to `pre-phase06-freeze` git tag (restores dual-auth code path); redeploy backend + reinstate `RBAC_SHARED_SECRET` env from vault; requires 2-admin Shamir approval; break-glass session pages security channel + auto-expires 15min. See Red Team Fix #1.
- **Traefik TLS option bug (all traffic broken)** → revert `tls-options.yml` via git → `docker compose exec traefik traefik reload` (Traefik hot-reload file provider)
- **step-ca crash** → sidecar restart via `docker compose restart step-ca`; existing certs unaffected (verify only, not issue). Traefik/central-rbac will pause startup via `depends_on` healthcheck.
- **step-ca PoC fails (Step 0)** → escalate for Vault fallback decision; do NOT proceed to Step 1

## Next Steps (dependencies for Phase 07)

- Phase 07 wizard needs `POST /v1/admin/apps` behind mTLS → Phase 06 must complete
- Phase 07 needs Zitadel SA with IAM_OWNER scope → provision separately from 3 Phase 06 SAs (different scope, don't overlap)
- Sectigo cert (if delayed) does NOT block Phase 07 start; document HTTP fallback
