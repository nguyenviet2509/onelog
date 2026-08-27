---
title: "Central RBAC Hardening & Self-Service"
description: "Harden central-rbac service auth (mTLS + SA JWT), add admin single-pane wizard, enable app self-registration of permissions"
status: pending
priority: P1
effort: 6w
branch: master
tags: [security, mtls, rbac, admin-ux, self-service, zitadel]
created: 2026-08-26
name: Central RBAC Hardening & Self-Service
slug: central-rbac-hardening-and-self-service
date: 2026-08-26
mode: hard
blockedBy: []
blocks: []
related:
  - 260821-1644-central-rbac-single-pane
  - 260821-1443-authway-security-hardening
  - 260819-1628-zitadel-native-oidc-multi-app-rollout
brainstorm: plans/reports/brainstorm-260826-1644-central-rbac-hardening-and-self-service.md
research:
  - plans/reports/researcher-260826-1644-central-rbac-hardening-prereqs.md
  - plans/reports/researcher-260826-1644-central-rbac-mtls-and-manifest.md
---

# Central RBAC Hardening & Self-Service

Continues predecessor MVP plan `260821-1644-central-rbac-single-pane` (phases 01-05 completed). Closes 4 gaps identified post-MVP: shared-secret S2S auth, plaintext service-to-service, split admin UX, YAML-only permission registration.

## Phases

| # | Phase | Duration | Status |
|---|---|---|---|
| 06 | [Security Foundation](phase-06-security-foundation.md) — kill shared secret, deploy step-ca + Traefik mTLS on sensitive endpoints, HTTPS termination | 2w | pending |
| 07 | [Admin Single-Pane Wizard](phase-07-admin-wizard.md) — proxy Zitadel `AddProject`+`AddOIDCApp` via `POST /v1/admin/apps` + React 2-step wizard | 2w | pending |
| 08 | [App Self-Registration](phase-08-app-self-registration.md) — permission manifest pull + diff review UI + namespace enforcement + OneMCP first adopter | 2w | pending |

## Key Dependencies

- Predecessor plan completed (phases 01-05) — auth webhook, JWKS verify, UI phase 4 all shipped
- **Interim HTTPS via step-ca server cert** (`rbac.<internal-domain>`) — plan proceeds without external Sectigo dep; Sectigo swap runbook applied when cert delivered (see Phase 06 Step 10a)
- **Adopter #2 deferred** — Phase 07/08 use synthetic app + OneMCP for validation; adopter #2 true validation in follow-up plan
- Related plan `260821-1443-authway-security-hardening` may overlap Zitadel TLS work — coordinate before Phase 06 start

## Top-level Success Criteria

- [ ] Admin non-tech tạo app mới trong <5 phút, chỉ dùng central-rbac UI
- [ ] Zero shared secret (`X-Rbac-Token`) trong service-to-service auth
- [ ] `/v1/resolve` + `/v1/admin/*` yêu cầu mTLS + JWT double check (verified via smoke test)
- [ ] Cert rotation runbook tested end-to-end (issue + rotate + revoke)
- [ ] App team ship permission mới không cần touch central-rbac repo (OneMCP as reference adopter)
- [ ] Audit log cover: app create, permission sync, cert issue (queryable)

## References

- Brainstorm: `plans/reports/brainstorm-260826-1644-central-rbac-hardening-and-self-service.md`
- Research (prereqs): `plans/reports/researcher-260826-1644-central-rbac-hardening-prereqs.md`
- Research (mTLS+manifest): `plans/reports/researcher-260826-1644-central-rbac-mtls-and-manifest.md`
- Predecessor: `plans/260821-1644-central-rbac-single-pane/plan.md`

## Red Team Review

### Session — 2026-08-27
**Findings:** 15 accepted (0 rejected)
**Severity:** 7 Critical, 8 High
**Report:** `plans/reports/red-team-260826-1644-central-rbac-hardening-findings.md`

| # | Finding | Severity | Applied To |
|---|---|---|---|
| 1 | mTLS rollout ordering auth-bypass window | Critical | Phase 06 |
| 2 | SSRF via manifest URL fetch | Critical | Phase 08 |
| 3 | mTLS CN header spoofing | Critical | Phase 06 |
| 4 | IAM_OWNER SA hardening (monthly rotate, Zitadel IP allowlist) | Critical | Phase 07 |
| 5 | step-ca PoC gate | Critical | Phase 06 |
| 6 | Traefik 2-TLS-options verification spike | Critical | Phase 06 |
| 7 | Cert expiry cron heartbeat + Telegram fallback | Critical | Phase 06 |
| 8 | Zitadel orphan cleanup durable queue | High | Phase 07 |
| 9 | Implicit deprecation UX (default UNCHECKED + banner) | High | Phase 08 |
| 10 | docker-compose depends_on step-ca healthcheck | High | Phase 06 |
| 11 | Rate-limit count all attempts + sliding window + preview limit | High | Phase 07 |
| 12 | Reuse OneLog audit hash-chain migrations 003/004 | High | Phase 07 + 08 |
| 13 | Namespace exact-segment match + slug prefix collision guard | High | Phase 08 |
| 14 | Manifest sha256 pin between review and apply | High | Phase 08 |
| 15 | `manifest_url` field in wizard (Phase 07 form) | High | Phase 07 + 08 |

## Validation Log

### Session 1 — 2026-08-27
**Trigger:** Post red-team decisions on implementation details not covered by phase files
**Questions asked:** 4

#### Confirmed Decisions

1. **[Architecture] HMAC secret for cert-CN header (Fix #3)** → **Docker secret + weekly cron rotate**
   - Rationale: Docker secret gives OS-level 0400 restriction; weekly rotation reduces exposure window; zero-downtime overlap during rotate. Applies to Phase 06 Step 7 (middleware) + docker-compose changes.

2. **[Architecture] step-ca root key backup (Fix #5)** → **Age-encrypted, offline (reuse OneLog backup pattern)**
   - Rationale: Consistent with existing `backup-age.pub` used for Zitadel/other backups; Bitwarden + QR paper storage; no new backup infra to learn. Applies to Phase 06 Step 4 (step-ca init).

3. **[Assumption] Audit migrations 003/004 origin (Fix #12)** → **From predecessor plan 260821-1644-central-rbac-single-pane** (verified via file content = `rbac.audit_log` schema)
   - Rationale: Predecessor plan created migrations but never committed. Cook Phase 07 Step 0.5 = commit + verify hash-chain covers new `app_create_audit` + `manifest_sync_audit` tables. Applies to Phase 07 + 08 migration wiring.

4. **[Risk] Zitadel SA IP allowlist (Fix #4)** → **Static IP of authway-vps as /32**
   - Rationale: authway-vps has static provider IP; /32 is tightest allowlist; VPS IP change = documented runbook step. LAN /24 too permissive. Applies to Phase 07 Step 1 (SA hardening).

#### Impact on Phases

- **Phase 06 Step 4**: step-ca init script writes root key → Age encrypt → offline storage per OneLog `backup-age.pub` pattern
- **Phase 06 Step 7**: Cert-CN HMAC middleware reads secret via `docker secret` mount; weekly cron `rotate-cert-hmac.sh` regenerates + rolling-restarts Traefik → backend
- **Phase 07 Step 0.5** (new): git-blame verify migrations 003/004 origin → commit as part of Phase 07 first commit; ensure hash-chain extends to new audit tables
- **Phase 07 Step 1**: SA IP allowlist = authway-vps static /32 (get exact IP from `ip addr` — likely 10.200.0.125 for internal calls; verify Zitadel sees external IP for public calls if any)
