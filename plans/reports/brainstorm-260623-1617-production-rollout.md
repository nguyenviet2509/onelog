# Brainstorm — Production Rollout onelog

**Date:** 2026-06-23
**Owner:** trihd@inet.vn
**Status:** Approved design, plan pending

## Problem statement

Chuyển onelog từ PoC single-node (logserver-01 + 2 mock client) sang **production**: VM prod mới + onboard 5 server thật đang phục vụ khách hàng.

## Constraints chốt

- VM prod mới (chưa có), spec do recommend
- 5 server Ubuntu/Debian + SSH key access
- Log volume 5-20 GB/ngày tổng
- **SSO Corp OIDC** (Keycloak/Azure AD/Google) — Phase 09 brought forward
- **PII cao** — data customer thật, cần legal signoff + redaction strict
- Anthropic key đã có budget
- Internal domain available

## Approaches considered

### A. Big-bang go-live (REJECTED)
- Migrate dev → prod VM + 5 client + SSO + LLM cùng lúc trong 1-2 tuần
- ❌ Risk cao: PII leak phát hiện muộn, SSO chưa stable, LLM cost surprise
- ❌ Rollback khó nếu fail

### B. Staged 7-phase rollout (APPROVED)
- Pre-flight gating → VM hardened → SSO → PII hardening → onboarding → LLM → ops → soak
- ✅ Mỗi stage có gating, fail-fast
- ✅ Soak 1 server trước khi roll 4 còn lại
- ✅ Tổng 3-4 tuần realistic

### C. Cloud-managed (REJECTED)
- Move sang AWS/GCP managed (RDS, OpenSearch, Bedrock)
- ❌ Internal policy bắt on-prem (suy luận từ corp domain + VPN-only)
- ❌ Cost lớn hơn 5-10×
- ❌ Phải redo Phase 01-04

## VM spec (recommendation)

| Component | Spec | Rationale |
|---|---|---|
| CPU | 8 vCPU | Vector + Indexer + Agent + Web + Postgres + Qdrant cùng VM |
| RAM | 32 GB | VL 4GB + Qdrant 8GB + Postgres 4GB + buffer/cache |
| SSD | 500 GB NVMe | 7d retention × 20GB + Qdrant + Postgres + buffer |
| OS | Ubuntu 22.04 LTS | Match client distro, LTS stable |
| Network | 1Gbps internal VLAN | Đủ cho 20GB/ngày = ~2 Mbps avg |

## Final design — 7 stages

### Stage 0 — Pre-flight gating (1-2d)
**Gating, không skip.**
- Legal/compliance signoff PII ingest (bằng văn bản)
- Threat model 1 trang
- Backup target chốt (NFS/MinIO/S3 corp)
- IdP team confirm OIDC endpoints

### Stage 1 — Prod VM hardened (2-3d)
- Provision VM 8C/32GB/500GB
- UFW + fail2ban + unattended-upgrades + ssh-key only
- Docker + compose (reuse `infra/scripts/setup-log-server.sh`)
- DNS `logserver.corp.local` + corp TLS cert (Caddy auto)
- Backup cron daily (VL/Qdrant/Postgres snapshot)
- Postgres data migrate từ dev (pg_dump)

### Stage 2 — SSO + Auth thật (3-5d) — parallel với 3
- NextAuth.js v5 + corp OIDC
- Postgres `users` table: sub, email, role
- API guard `/api/chat` + `/api/conversations/*` + `/api/admin/*`
- Agent nhận `X-User-Id` từ Web, reject direct
- `audit_log.user_id` = real
- `/admin/*` role-gated

### Stage 3 — PII redaction hardening (2-3d) — parallel với 2
- Mở rộng regex Vector: email/phone VN/CCCD/CC/JWT/IPv4 public + **PII format khách hàng**
- Pre-ingest dry-run 1k line/server → audit thủ công
- Vector `assert` transform fail-closed nếu un-redacted match
- Drain3 template review
- Document policy → legal sign

### Stage 4 — Client onboarding (2-3d, sau Stage 1)
- Script `infra/scripts/install-onelog-client.sh` idempotent
- rsyslog forward 6514 TLS + CA cert
- Hostname + service tag chuẩn hoá
- **Pilot 1 server 24h** đo volume thật
- Roll out 4 server còn lại tuần tự 1/ngày

### Stage 5 — Real LLM + eval (2-3d, sau Stage 2)
- Set keys + `LLM_MOCK=false`, `EMBED_MOCK=false`
- Re-embed Qdrant bằng OpenAI ada
- **Anthropic console hard budget cap** (mandatory)
- Phase 05 eval harness 20 case → baseline
- Per-user token quota (defer nếu user count nhỏ)

### Stage 6 — Operational readiness (2-3d, parallel với 5)
- VictoriaMetrics scrape `/metrics` agent + indexer + web
- Grafana dashboard: ingest/lag/qdrant/p95/cost/disk
- Oncall alert (Telegram khác): disk>80%, restart loop, indexer lag>5m
- **Backup restore drill** (gating)
- Runbook 1 trang: oncall rota + top 5 incident playbook

### Stage 7 — Soak + iterate (1 tuần)
- Daily check script
- Sysadmin feedback 2-3 session
- Drain3 tune (unmatched < 5%)
- Redaction adjust nếu leak
- Cost review tuần đầu

## Timeline

| Stage | Days | Parallel |
|---|---|---|
| 0 | 1-2 | — |
| 1 | 2-3 | — |
| 2 | 3-5 | ‖ 3 |
| 3 | 2-3 | ‖ 2 |
| 4 | 2-3 | sau 1 |
| 5 | 2-3 | sau 2 |
| 6 | 2-3 | ‖ 5 |
| 7 | 7 | — |
| **Total** | **3-4 tuần** | |

## Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Legal signoff block 1-2 tuần | High | Đẩy Stage 0 ngay, parallel với 1 |
| 2 | IdP team chưa sẵn OIDC | Medium | Fallback Caddy basic_auth tạm |
| 3 | PII leak sau redaction | **Critical** | Post-ingest audit job daily + alert |
| 4 | LLM cost runaway | High | Anthropic console hard limit must-have |
| 5 | Vector TLS cert distribution | Medium | Decide corp CA vs mkcert + automate ở Stage 4 |
| 6 | Backup restore chưa drill | High | Stage 6 gating, không go-live nếu fail drill |
| 7 | Disk overflow trước retention prune | Medium | Monitor + alert > 80%, extend retention sau soak |

## Success criteria

- 5/5 server forward log ổn định 7 ngày
- PII audit 0 leak qua 7 ngày
- SSO login + role-based access work
- LLM chat p95 < 8s với key thật
- Backup restore drill pass
- Oncall page test pass
- Cost tuần đầu < budget cap

## Unresolved questions

1. Legal team đã ack PII ingest chưa? Document policy có sẵn?
2. Corp CA hay Let's Encrypt internal cho TLS server-side?
3. IdP team timeline cấp OIDC client credentials?
4. Backup target cụ thể: NFS / MinIO / S3 corp?
5. PII format custom của khách hàng (sample log để build regex)?
6. Anthropic monthly budget cap: $? (cần số cụ thể)
7. Oncall rota có sẵn hay build mới?
8. Vector TLS cert: corp CA hay tự sinh CA?

## Next steps

Tạo plan `260623-XXXX-production-rollout/` với 7 phase tương ứng 7 stage, dependencies + parallel groups rõ ràng. Mỗi phase có own phase file (phase-00 đến phase-07).
