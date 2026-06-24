# Phase 01 — Prod VM Hardened

## Context
- [plan.md](plan.md) | [Brainstorm §Stage 1](../reports/brainstorm-260623-1617-production-rollout.md)

## Overview
- Priority: P0
- Status: pending
- Effort: 2-3 ngày
- Mục tiêu: Provision VM prod 8C/32GB/500GB, hardening, DNS + TLS thật, backup target, migrate Postgres data từ dev.

## Requirements
- VM Ubuntu 22.04 LTS 8 vCPU / 32GB RAM / 500GB NVMe
- Internal DNS A record `logserver.corp.local`
- TLS cert từ corp CA (hoặc Let's Encrypt internal)
- Backup target mount sẵn (NFS/MinIO/S3 — chốt ở Phase 00)
- UFW + fail2ban + unattended-upgrades + ssh key-only

## Related files
- `infra/scripts/setup-log-server.sh` — reuse, có thể extend hardening flags
- `infra/scripts/install-docker.sh` — reuse
- `infra/caddy/Caddyfile` — update domain + TLS
- `infra/scripts/backup-daily.sh` — **create**
- `infra/.env` — production values (KHÔNG commit)
- `infra/.env.example` — template prod values

## Implementation steps
1. Request VM provision theo spec
2. Initial hardening: ssh key-only, disable password, UFW (open 22/80/443/514/6514), fail2ban, unattended-upgrades
3. Install Docker + compose plugin (reuse script)
4. Clone repo + setup `.env` từ secret store (sops/Vault hoặc thủ công)
5. Update Caddyfile: replace IP với `logserver.corp.local`, enable real TLS
6. Mount backup target (`/mnt/backup`)
7. Write `infra/scripts/backup-daily.sh`:
   - `pg_dump` → gzip → backup mount
   - Qdrant snapshot API → tar → backup mount
   - VL `/api/v1/admin/storage/snapshot` → backup mount
   - Retention 30 ngày
8. Cron daily 02:00
9. Migrate Postgres data từ logserver-01: `pg_dump | psql` (chỉ users + conversations + messages + audit_log)
10. Bring up stack với profiles: `docker compose --profile web --profile agent --profile indexer --profile alerts --profile mcp up -d`
11. Smoke test: health endpoint + chat + alert webhook

## Todo
- [ ] VM provisioned
- [ ] Hardening done
- [ ] Docker + compose installed
- [ ] DNS + TLS work (`https://logserver.corp.local` → cert valid)
- [ ] Backup script + cron
- [ ] Postgres data migrated
- [ ] All services up + health pass
- [ ] Test backup → verify file exist trên backup mount

## Success criteria
- `curl https://logserver.corp.local/api/admin/health` returns ok=true 4/4
- `ls /mnt/backup/$(date +%F)/*.gz` có 3 file (postgres + qdrant + vl)
- UFW deny tất cả ngoài whitelist
- ssh password-auth disabled

## Risks
- VM spec không đáp ứng → đo lại sau Phase 04 pilot, scale up nếu cần
- Backup mount fail → service vẫn chạy nhưng không có DR. Alert cron failure

## Security
- `.env` mode 600, owner root
- Backup target có encryption at-rest (LUKS/server-side)
- ssh chỉ admin team keys

## Next steps
Sang Phase 02 (SSO) + Phase 03 (PII) + Phase 04 (onboarding) — parallel.
