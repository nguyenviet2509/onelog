# Phase 01 — Hạ tầng base (VM + docker-compose + VictoriaLogs + Qdrant + Postgres + Caddy)

## Context
- Plan: [plan.md](plan.md)
- Design: [brainstorm report §4, §6](../reports/brainstorm-260622-1056-rag-logserver-victorialogs.md)

## Overview
- Priority: P0 (blocker mọi phase sau)
- Status: pending
- Mục tiêu: VM Ubuntu LTS chạy docker-compose stack: VictoriaLogs + Qdrant + Postgres + Redis + Caddy reverse proxy. Có persistent volume, snapshot, TLS, monitoring cơ bản.

## Requirements
- VM: 16 vCPU, 32GB RAM, SSD 1TB, Ubuntu 22.04/24.04 LTS
- Docker Engine + docker-compose v2
- Firewall: chỉ mở port admin (SSH) + syslog ingest (514/6514) + HTTPS 443 (Caddy) + Telegram outbound + LLM API outbound. **Khi auth chưa setup**: thêm IP whitelist source ở Caddy cho subnet sysadmin nội bộ (thay thế tạm cho auth).
- Persistent volumes mount /data (VictoriaLogs, Qdrant, Redis)
- Snapshot script daily → local /backup hoặc MinIO

## Architecture
```
/opt/ragstack/
├── docker-compose.yml
├── .env (sops-encrypted secrets)
├── victorialogs/  (data volume)
├── qdrant/        (data volume)
├── redis/
└── backup/
```

## Related Code Files
Create:
- `infra/docker-compose.yml`
- `infra/.env.example`
- `infra/scripts/snapshot-daily.sh`
- `infra/scripts/restore-qdrant.sh`
- `infra/systemd/ragstack.service`
- `docs/deployment-guide.md` (update)

## Implementation Steps
1. Provision VM, bật UFW: allow 22/tcp, 514/udp, 6514/tcp, deny rest inbound
2. Cài Docker Engine + compose plugin theo official repo
3. Viết `docker-compose.yml`:
   - `victorialogs`: image `victoriametrics/victoria-logs:latest`, port 9428, volume `./victorialogs:/victoria-logs-data`, flags `-retentionPeriod=90d -storageDataPath=/victoria-logs-data`
   - `qdrant`: image `qdrant/qdrant:latest`, port 6333/6334, volume `./qdrant:/qdrant/storage`, env `QDRANT__SERVICE__API_KEY` từ .env
   - `postgres`: image `postgres:16-alpine`, port 127.0.0.1:5432, volume `./postgres:/var/lib/postgresql/data`, env `POSTGRES_DB=rag`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
   - `redis`: image `redis:7-alpine`, port 127.0.0.1:6379 only, volume `./redis:/data`, `--appendonly yes`
   - `caddy`: image `caddy:2-alpine`, port 80/443, volume `./caddy/Caddyfile:/etc/caddy/Caddyfile`, `./caddy/data:/data`, reverse proxy `/` → web (Phase 04), `/api` + `/mcp` → agent
4. Tạo `.env.example` với placeholder: `QDRANT_API_KEY`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `APP_DOMAIN`. **Auth defer**: chưa thêm `OIDC_*` / `NEXTAUTH_SECRET`, sẽ bổ sung khi chốt auth method (email/pass hoặc SSO).
5. Cài sops + age, encrypt `.env` thành `.env.enc`
6. Snapshot script: `qdrant snapshot create` + `pg_dump rag` + `cp -a victorialogs/data` + tar.gz → /backup, giữ 7 ngày
7. Cron snapshot 02:00 daily
8. Healthcheck script: `curl http://localhost:9428/health` + `curl http://localhost:6333/healthz`
9. Tạo systemd unit wrap `docker compose up` for auto-restart
10. Smoke test: ingest 1 log qua VictoriaLogs HTTP, query lại; create Qdrant collection test, upsert 1 point

## Todo
- [ ] Provision VM + hardening (UFW, fail2ban, ssh key only)
- [ ] Cài Docker + compose
- [ ] Viết docker-compose.yml (5 service: VL, Qdrant, Postgres, Redis, Caddy)
- [ ] DNS A record cho APP_DOMAIN → VM
- [ ] Caddyfile (TLS LE, reverse proxy stub cho web/agent)
- [ ] sops + age setup, encrypt .env
- [ ] Snapshot + restore script (VL + Qdrant + Postgres dump)
- [ ] systemd unit
- [ ] Smoke test ingest + query + Postgres connect + Caddy TLS
- [ ] Doc deployment-guide.md

## Success Criteria
- `docker compose ps` 3/3 healthy
- VictoriaLogs nhận log test (HTTP POST `/insert/jsonline`) và query trả về
- Qdrant tạo collection, upsert + search trả về
- Redis ping OK, AOF file tăng khi set key
- Snapshot script chạy không lỗi, restore test thành công
- Reboot VM → stack tự up qua systemd

## Risks
- Disk full do VictoriaLogs retention quá lâu → set `-retentionPeriod=90d` + alert disk >80%
- Qdrant API exposed → bind 127.0.0.1 + API key bắt buộc
- Mất .env → sops + age key backup offsite

## Security
- SSH key only, disable password
- Qdrant + Redis chỉ bind 127.0.0.1, expose nội bộ qua docker network
- API key trong sops, không commit plaintext
- UFW chặn mọi port không cần

## Next Steps
- Phase 02 dùng VictoriaLogs + Qdrant đã sẵn sàng
