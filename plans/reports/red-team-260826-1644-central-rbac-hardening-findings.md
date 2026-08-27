# Red Team Review — Central RBAC Hardening & Self-Service

**Plan:** `plans/260826-1644-central-rbac-hardening-and-self-service/`
**Date:** 2026-08-27
**Reviewers:** Security Adversary + Assumption Destroyer + Failure Mode Analyst (3 parallel)
**Raw findings:** 30 (deduped to 15)

## Severity breakdown

- **7 Critical** (block Phase 06 kickoff or Phase 06 exit gate)
- **8 High** (must fix before prod cutover)

## Adjudication summary

| # | Finding | Severity | Reviewer | Disposition | Apply to |
|---|---|---|---|---|---|
| 1 | mTLS rollout ordering auth-bypass window (shared secret deleted before all consumers migrated; `MTLS_ENFORCE=false` naked bypass) | Critical | Failure + Assumption + Security | **Accept** | Phase 06 |
| 2 | SSRF via manifest URL fetch (no allow-list, no RFC1918/link-local block, no IP pin) | Critical | Security | **Accept** | Phase 08 |
| 3 | mTLS CN header spoofing (backend trusts `X-Client-Cert-CN` without proof it came from Traefik; direct docker network reachability) | Critical | Security | **Accept** | Phase 06 |
| 4 | IAM_OWNER SA static creds on disk; rate-limit only at central-rbac (Zitadel-side bypassable if creds stolen) | Critical | Security + Assumption | **Accept** | Phase 07 |
| 5 | step-ca "30-min setup" is docs claim, no in-repo PoC; Phase 06 timeline at risk | Critical | Assumption | **Accept** | Phase 06 |
| 6 | Traefik v3 same-hostname 2-TLS-options pattern unverified (may leak or block webhook) | Critical | Assumption | **Accept** | Phase 06 |
| 7 | Cert expiry cron SPOF: silent death → weekend outage; alert path via Alertmanager per known reload pitfall | Critical | Failure | **Accept** | Phase 06 |
| 8 | Zitadel `AddProject` succeeds, `AddOIDCApp` fails → orphan project + wizard 409-forever; best-effort rollback + weekly cron inadequate | High | Failure | **Accept** | Phase 07 |
| 9 | Implicit deprecation (missing key → deprecate candidate) UI defaults ALL checked → app-side typo bug wipes permission | High | Failure | **Accept** | Phase 08 |
| 10 | docker-compose no `depends_on` step-ca healthcheck → post-reboot Traefik loads with missing CA bundle → mTLS silently disabled | High | Failure | **Accept** | Phase 06 |
| 11 | Rate-limit success-only counting bypassable via forced validation failures; sliding window ambiguous vs calendar-day; preview endpoint unlimited | High | Security + Failure | **Accept** | Phase 07 |
| 12 | Audit log mutable (plain UPDATE-able), no hash-chain — existing OneLog migrations 003/004 not reused | High | Security | **Accept** | Phase 07 + 08 |
| 13 | Namespace prefix collision (`onemcp` vs `onemcp-lab`) — `startsWith` check + no slug-prefix-collision enforcement | High | Security | **Accept** | Phase 08 |
| 14 | TOCTOU manifest apply — Apply endpoint accepts `approved_ids[]` only, no sha256 pin between review + apply | High | Security | **Accept** | Phase 08 |
| 15 | `manifest_url` design gap — Phase 08 migration adds column but Phase 07 wizard doesn't collect it; sync endpoint has no URL source | High | Assumption | **Accept** | Phase 07 + 08 |

**All 15 findings accepted.** No rejects — every finding is evidence-based and concrete.

---

## Fix directives per finding

### Critical

**#1 — mTLS rollout ordering auth-bypass:**
- Phase 06 backend supports BOTH `X-Rbac-Token` AND mTLS+JWT concurrently during rollout
- Only after Step 15 (all consumers verified mTLS in prod 48h) does a follow-up step (new Step 15.5) remove shared-secret code path
- Delete `MTLS_ENFORCE=false` env entirely (or gate behind Shamir-split 2-admin break-glass, 15-min auto-expire, immediate page)
- Tag `pre-phase06-freeze` created in Step 12.5 (before backend deploy)

**#2 — SSRF:**
- Add `manifest_url` field to Phase 07 wizard (see #15), immutable after set
- Fetcher: (a) HTTPS-only, (b) resolve DNS once + pin IP, (c) reject if IP is RFC1918/loopback/link-local/169.254/multicast, (d) block redirects OR re-validate destination after each redirect, (e) request size cap already listed, keep

**#3 — CN header spoofing:**
- Traefik ingress: strip `X-Client-Cert-*` from inbound BEFORE middleware sets it (explicit `headers.customRequestHeaders` = empty)
- central-rbac backend: bind only to Traefik network; docker network isolation + refuse direct TCP from other sources
- Sign header with rotating HMAC secret shared Traefik plugin ↔ backend; backend rejects if signature invalid
- Auth chain default-applied globally with explicit opt-out per route, not opt-in

**#4 — IAM_OWNER SA hardening:**
- Rotate monthly (not quarterly)
- Zitadel-side IP allowlist on SA (only central-rbac egress IP)
- File-integrity monitoring (auditd or inotify) on `/root/.secrets/*.json`
- Zitadel-side audit alarm on any `AddProject` originating from non-central-rbac IP (defense against direct SA JWT abuse)

**#5 — step-ca PoC:**
- Add Phase 06 Step 0: 1-day timeboxed PoC on `onelog-source` lab producing (a) pinned image digest, (b) non-interactive `step ca init` script, (c) working `openssl s_client` handshake against Traefik with client cert
- Gate: only proceed to Step 1 if PoC succeeds. If fails, escalate to user for Vault fallback decision

**#6 — Traefik 2-TLS-options verification:**
- Add Phase 06 Step 6a (spike): matrix test on lab — 4 curl variants (webhook w/o cert, webhook w/ cert, resolve w/o cert, resolve w/ cert) against same hostname with 2 TLS options
- If pattern fails, split hostnames: `rbac-webhook.<domain>` (open) + `rbac-internal.<domain>` (strict-mtls). Add DNS + Traefik router changes to Step 6
- Pin Traefik image version explicitly in compose file

**#7 — Cert expiry cron SPOF:**
- Cron script writes success timestamp to file; Prometheus `node_textfile` scrape checks freshness → alert if stale >2 days
- Include intermediate CA expiry check (not just leaf certs)
- Direct Telegram fallback (curl bot API) if Alertmanager unreachable
- Alert threshold 60d not 30d (weekend/holiday buffer)
- **Reuse memory `alertmanager-config-reload.md`**: when adding rule, must `docker compose restart alertmanager`, not SIGHUP

### High

**#8 — Zitadel orphan cleanup:**
- Insert `pending_cleanups` durable job on `RemoveProject` failure; background worker retries exp backoff
- Wizard `SearchProjects` step also queries `pending_cleanups` and offers "reclaim orphan" flow to admin

**#9 — Implicit deprecation UX:**
- Implicit deprecations (missing key in manifest) default UNCHECKED in diff UI + warning banner "unexpected removal detected"
- Explicit deprecations (manifest declares `status: soft-deleted`) can default checked
- Sync response highlights "unexpected deletions" as separate diff category

**#10 — docker-compose ordering:**
- Add `healthcheck` to step-ca service (`step ca health` cmd)
- `depends_on: step-ca: {condition: service_healthy}` for Traefik + central-rbac
- Post-reboot smoke test added to cert rotation runbook
- Traefik `restart: on-failure` with startup retry for missing CA files

**#11 — Rate-limit:**
- Count ALL attempts reaching Zitadel `AddProject` (any 2xx response), not just success
- Explicit sliding 24h window (drop calendar-day)
- Rate-limit preview endpoint (10/hour/admin)
- Recent-creates digest email to security channel every 4h

**#12 — Audit hash chain:**
- Reuse existing OneLog migrations `003_audit_hash_chain.sql` + `004_audit_immutable_trigger.sql` — extend hash chain to cover `rbac.app_create_audit` + `rbac.manifest_sync_audit`
- DENY UPDATE/DELETE on audit tables at DB role level
- Ship audit stream to append-only sink (S3 object-lock) as follow-up (out of scope this plan, note)

**#13 — Namespace collision:**
- Enforce slug format `^[a-z][a-z0-9]{2,31}$`
- Reject new slug that is a prefix of, or has as prefix, any existing slug
- Namespace check MUST split on `:` and compare first segment EXACTLY (drop `startsWith`)
- Case-insensitive uniqueness

**#14 — TOCTOU manifest:**
- Diff response includes sha256 of full manifest body + etag
- Apply endpoint requires client to submit sha256; server either (a) re-fetches + rejects if changed, or (b) applies from server-side cached copy indexed by sha256 (preferred)

**#15 — `manifest_url` design gap:**
- Add `manifest_url` optional field to Phase 07 wizard Step 1 form (validate HTTPS + public DNS at wizard time)
- Add Phase 08 "Edit app manifest URL" UI (from Apps list) for existing apps
- Default convention: auto-derive `{callback_urls[0].origin}/.well-known/rbac-permissions.json` if not explicitly set

---

## Cross-cutting recommendations

1. **Add Phase 06 Step 0 (PoC gate)**: 1 day timeboxed, gates whole Phase 06 execution
2. **Add Phase 06 Step 15.5 (post-cutover shared-secret removal)**: separates dual-auth from clean-cut removal
3. **Reorder Phase 07-08 interaction**: `manifest_url` must be in wizard from day 1 (block Phase 08 diff sync otherwise)
4. **Bake existing OneLog hash-chain migrations into audit design**: they exist in the tree (untracked untracked from predecessor plan)
5. **Named Adopter #2 confirmation**: not covered in these 15 findings but flagged separately — assign owner + confirmation deadline before Phase 07 kickoff

## Unresolved for user

- Which Adopter #2 will validate wizard + manifest end-to-end?
- Sectigo cert ETA — hard decision on step-ca-issued interim vs Phase 07 slip
- Approve reuse of migrations 003/004 hash-chain for new audit tables?
- Slug format regex `^[a-z][a-z0-9]{2,31}$` OK, or tighter?
