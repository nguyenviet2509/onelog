# Research: Central RBAC Hardening — Prereq Questions Resolved

**Date:** 2026-08-26 16:44 | **Author:** researcher | **Trigger:** Brainstorm session Q1-Q3

---

## Topic 1: Zitadel v4.16.1 Granular API Scope for Project Creation

### Findings

- **v4 custom roles bug:** Issue #10505 (GitHub/zitadel) reported that v4 project owners cannot create roles in projects they own. Affects both UI + API. Unknown if fixed post-reported version.
- **Granular scope limits:** Zitadel v4 exposes `IAM_OWNER`, `ORG_OWNER`, `PROJECT_OWNER` roles. NO evidence of `PROJECT_CREATOR` or `ORG_PROJECT_CREATOR` granular roles in v4.16.1 docs or GitHub discussions.
- **AddProject / AddOIDCApp permissions:** Management API docs (zitadel.com) list these RPC methods but **do not specify required permission scope explicitly**. GitHub discussion #8450 ("manage orgs from service user") suggests `IAM_OWNER` is typical for project creation, with no finer-grained alternative discovered.
- **Workaround in practice:** Teams using Zitadel service accounts for OIDC setup typically escalate to `IAM_OWNER` (or `ORG_OWNER` if org-scoped) temporarily, with rate-limit + audit compensating for scope breadth.

### Recommendation for OneLog

**Skip custom role attempt — not available in v4.16.1.** Use baseline `IAM_OWNER` scope for central-rbac SA, with mitigations:

1. **Rate-limit `POST /v1/admin/apps`** → 5/day quota (default deny, whitelist override).
2. **Audit every project creation** → log service account token ID + timestamp + project name.
3. **Alert threshold** → fire if >3 creates/day (anomaly detector).
4. **Scope isolation**: Restrict SA to single org (not global admin). Zitadel v4 supports `org_id` claim.

**Cost:** Negligible (audit logging 1–2 tuần dev). **Benefit:** Defer custom-role engineering until v5 or alternative IdP.

### Implementation Implications

- Brainstorm "Concern #1" Option C (hybrid wizard) remains viable; just accept `IAM_OWNER` temp escalation.
- Pre-create 1 test project in Zitadel before wiring SA (to verify scope works).
- Document SA credentials rotation SOP (monthly).

### Citations

- [Issue #10505: project owners cannot create roles in v4](https://github.com/zitadel/zitadel/issues/10505)
- [Add Project Member API (deprecated, use CreateAdministrator)](https://zitadel.com/docs/reference/api/management/zitadel.management.v1.ManagementService.AddProjectMember)
- [Discussion #8450: manage orgs from service user](https://github.com/zitadel/zitadel/discussions/8450)
- [Management API reference](https://zitadel.com/docs/reference/api/management)

---

## Topic 2: step-ca vs HashiCorp Vault PKI for Internal mTLS

### Findings

**step-ca (smallstep/step-ca):**
- Single Go binary, embedded Badger DB or MySQL/PostgreSQL backend.
- Docker image: `smallstep/step-ca` (lightweight, ~100MB base).
- ACME server built-in; 24-hour default cert lifetime (configurable to 90-day via `maxTLSCertDuration: "2160h"`).
- Renewal pattern: `step ca renew --daemon` sidecar + cron. Works with any ACME v2 client (Traefik, Caddy, certbot, etc.).
- Setup: ~30 min (init PKI, gen root/intermediate, render config, docker run).
- Ops burden: Minimal — cert rotation via ACME renew script (can be cron or systemd timer).
- Offline root support: ✓ (root stored offline, intermediate signs all certs).
- HA: Requires shared DB (MySQL/PG); stateless step-ca containers scale easily.

**HashiCorp Vault PKI:**
- Broader scope: secrets engine (SSH, DB, PKI, transit, etc.) + multi-auth (LDAP, OIDC, Kubernetes, etc.).
- Setup: ~2–3 hours (HA Raft cluster setup, storage backend config, auth method tuning, policy templating).
- Cert model: Short-lived (default 1-2 weeks); app calls Vault API on boot → get cert → auto-renew via lease.
- Renewal: Programmatic (Vault handles lease renewal); no manual rotation script needed.
- No ACME server (Vault v1.11+ has multi-issuer support; no ACME endpoint).
- HA: Native raft consensus (3–5 nodes recommended); complex operational readiness.
- Ops burden: Medium–high (seal/unseal, backup strategy, lease monitoring, audit log rotation).

### Comparison for OneLog Context

| Dimension | step-ca | Vault PKI |
|---|---|---|
| **Setup time** | ~30 min | 2–3 hours |
| **Ops per 6mo** | 1–2 cert renewals (cron) | Lease mgmt + audit log purge + backup test |
| **Offline root** | ✓ Easy | ✓ Possible (complex) |
| **HA needed now** | No (3-4 services, <5 certs) | No (overkill) |
| **ACME client integration** | Native (Traefik, Caddy) | None (custom API code) |
| **Learning curve** | Low (PKI 101) | High (secrets paradigm) |
| **No existing Vault** | Baseline | Extra burden |

### Recommendation for OneLog

**→ step-ca (immediate phase), Vault deferred (future multi-team scale).**

**Rationale:**
- OneLog has no existing Vault deployment. Vault introduces ops overhead for a single team managing 5–10 certs.
- 3 VPS in same LAN (onelog-vps, onemcp-vps, authway-vps) → shared PKI scope modest.
- step-ca ACME + Traefik integration = automatic renewal with zero app changes (already familiar to team).
- Defer Vault to Phase 09+ when adopters scale to 5+ teams (multi-tenant auth secrets).

**Deployment sketch:**
1. Deploy `smallstep/step-ca` sidecar in authway-vps stack (separate from Zitadel).
2. Bootstrap: `step ca init --profile=root-only` (root offline), intermediate on-disk.
3. Traefik entrypoint `/v1/resolve` mTLS: configure `ClientCA` cert pool from step-ca intermediate.
4. Renewal: `step certificate install` (cron on consumer VPS, fetch + rsync cert from step-ca sidecar output).
5. Monitoring: Script `check-cert-expiry.sh` daily (30-day alert threshold).

### Implementation Implications

- Phase 6 (security foundation) gains ~1 week step-ca setup (light).
- No app-level code change (mTLS transparent at Traefik layer).
- Cert rotation runbook = 5 shell scripts (gen, distribute, verify, alert).

### Citations

- [step-ca Docker setup tutorial](https://smallstep.com/docs/tutorials/docker-tls-certificate-authority/)
- [step-ca + ACME automation (zero-downtime rotation)](https://dev.to/tim_derzhavets/zero-downtime-certificate-rotation-building-resilient-acme-automation-d9p)
- [Vault PKI rotation primitives](https://developer.hashicorp.com/vault/docs/secrets/pki/rotation-primitives)
- [step-ca vs Vault comparison (Axelspire 2026)](https://axelspire.com/vault/vendors/private-ca-comparison/)

---

## Topic 3: Cross-DC Threat Model for OneLog VPS Fleet

### Findings

**Current topology (from docs + memory):**
- **onelog-vps:** private 10.200.0.30 (eth1)
- **authway-vps:** private 10.200.0.125 (eth1)
- **onemcp-vps:** (inferred) private 10.200.0.X (eth1)
- **Private network:** 10.200.0.0/24 isolated LAN
- **Public IPs:** onelog-vps 202.92.5.112 (eth0), onemcp-vps 202.92.5.113 (eth0)
- **Cloud provider:** Vultr / GCP mentioned in runbook break-glass access; backup via `000nethost` S3 (Vietnamese ISP).

**Single-DC placement (evidence):**
- All VPS communicate via 10.200.0.0/24 private LAN → **same provider network** (not cross-region).
- Runbook states "cloud provider console" (singular) for hard restart → **single provider account**.
- No VPN / Wireguard config mentioned → **no cross-DC infrastructure**.
- Backup offsite refers to "different failure domain" (S3 region, not VPS region) — implies S3 is separate, not VPS multi-DC.

**Threat model:** All VPS in same datacenter (single provider LAN). Private network 10.200.0.0/24 = L2/L3 isolated at provider level (not user-exposed). Compromise 1 VPS → lateral movement to all others over unencrypted private LAN.

### Recommendation for OneLog

**mTLS sufficient for current topology. Wireguard NOT needed (yet).**

**Rationale:**
- Single-DC placement → provider already isolates LAN at physical layer.
- mTLS (step-ca) provides app-level identity + encryption (defense in depth).
- Wireguard adds complexity without matching threat model (no cross-DC traffic to protect).
- **Defer Wireguard mesh** until: (a) adopters deploy on separate VPS in different DC, OR (b) trust boundary broadens beyond LAN.

**If future cross-DC adoption occurs:**
- Add Wireguard peer mesh (onelog-vps ↔ authway-vps ↔ onemcp-vps).
- Tunnel over public IP (202.92.5.112/113 + future IPs).
- mTLS + Wireguard = 2-factor encryption (defense in depth).

### Implementation Implications

- Phase 6 (security foundation): **skip Wireguard**. Proceed with mTLS only.
- Document assumption in security.md: "Single-DC, provider LAN isolation assumed. Revisit if cross-DC."
- Monitoring: Track private LAN latency (10.200.0.0/24) as DC health proxy.

### Citations

- Host sync policy: `.claude/rules/host-sync-policy.md` (maps repo ↔ VPS, single DC implied)
- Authway runbook: `docs/authway-runbook.md` (Vultr/GCP console access + 10.200.0.125 private IP)
- Memory: [VPS dual-NIC policy routing](memory/vps-dual-nic-policy-routing.md) (eth0=public, eth1=private 10.200.0.0/24)

---

## Summary & Next Steps

| Question | Resolution | Phase impact |
|---|---|---|
| Q1: Zitadel granular scope for AddProject? | Not in v4.16.1; use `IAM_OWNER` + audit mitigations | Phase 6 planning: accept scope cost |
| Q2: step-ca vs Vault? | step-ca (lightweight, immediate) + Vault later (scale) | Phase 6 +1 week setup |
| Q3: Cross-DC threat model? | Single-DC confirmed; mTLS sufficient, Wireguard defer | Phase 6 mTLS-only |

**Blockers resolved:** None. All 3 design choices feasible with stated mitigations.

**Unresolved / defer:**
1. **Exact Zitadel v4.16.1 build date:** Verify with user if this is Dec 2024 build or later patch. v5 alpha may have custom roles (unverified).
2. **OneMCP-vps private IP:** Assumed 10.200.0.X; verify exact IP for Wireguard planning (future).
3. **S3 bucket region:** Backup docs say "different region" but current `000nethost` region unknown. Document for DR.
