# 2026-08-21 — OneMCP monitor + backup shipped

Plan [260821-1346-onemcp-monitor-backup-integration](../../plans/260821-1346-onemcp-monitor-backup-integration/plan.md) 5 phase xong end-to-end trong ~1.5h (est 3-4h). Apply pattern authway (plan `260821-1013`) sang OneMCP.

## Kết quả

- **Metrics scrape 7 target UP**: node/cadvisor/backend/postgres/redis/2 blackbox HTTP probe.
- **Vector agent** forward 4+ service (backend, postgres, redis, minio, syslog, auth) → VL `host=onemcp`. Stream tuple đúng `_stream="{host=\"onemcp\",service=\"backend\"}"`.
- **Grafana dashboard "OneMCP Overview"** — UID `onemcp-overview`, 14 panels (UP state, backend HTTP/duration, Postgres tx/connections, Redis ops+mem, host CPU/RAM/disk, container top-5).
- **9 vmalert rules** (4 critical + 5 warning) trong 2 group `onemcp-{critical,warning}`.
- **Alertmanager route** `cluster="onemcp"` → `telegram-trend` (topic 880). Đặt sau authway matcher.
- **Backup replaced**: bỏ backup service local-only (không encrypt), triển khai age-encrypted S3 offsite (`s3://backups-onemcp-server`). Cron `0 2 * * *`.
- **E2E firing test verified**: `docker compose stop backend` → `OnemcpBackendDown` firing → receiver=`telegram-trend` → restart auto-resolve.
- **E2E restore test verified**: download from S3 → decrypt → scratch Postgres 16 với pgvector → globals + schema+data restored → row count match production (skills=1, artifacts=20, users=6), pgvector extension present.

## 3 commit

- OneMCP `4887746` feat(observability): monitor sidecars + Vector agent
- OneMCP `6b8b6e2` feat(backup): replace local-only backup with age-encrypted S3 offsite
- OneLog (pending finalize commit)

## Gotchas + learning

1. **`.env` unquoted cron spec breaks source loading** — Old backup service used `BACKUP_CRON=0 3 * * *` unquoted trong `.env`. `set -a; . .env` treat as shell → `3 * * *` = command not found. Fix: remove obsolete env var. Learning: khi bỏ 1 service, sweep `.env` cho biến chỉ dùng bởi service đó — không chỉ compose block.

2. **oneconnector.000nethost.com không reach từ onelog-vps** — Public IP `202.92.5.113` không được route giữa 2 VPS cùng DC. Fix: blackbox probe qua private IP `10.200.0.44:3000/health` thay vì HTTPS public. Learning: đối với monitor cross-VPS trong cùng DC, luôn dùng private IP — public IP có thể bị firewall/routing block ngay cả khi ping OK.

3. **pgvector extension trong pg_dump** — mặc định pg_dump có include `CREATE EXTENSION IF NOT EXISTS vector` nhưng grep với head=10 miss (extension list sort alphabetical, `vector` cuối). Learning: khi verify, đừng tin blindly `head` output — dùng exact grep pattern trước.

4. **Backend `prom-client` metrics prefix** — Backend NestJS đã có `/metrics` với prefix `onemcp_*` (không phải default `nodejs_*`). Dashboard PromQL phải dùng đúng prefix. Learning: verify prefix trước khi build dashboard panels — nếu sai sẽ blank panel không rõ nguyên nhân.

5. **Ubuntu 24.04 apt awscli removed** — Same as authway migration. pipx install → symlink `/usr/local/bin/aws`. Learning: đã save vào memory `vl-cross-vps-binding.md` cho lần sau.

## Điểm hay của pattern (validated)

- **Reuse toàn bộ hạ tầng** — cùng S3 endpoint + age master key + AWS creds + telegram receiver `telegram-trend` + blackbox_exporter. 0 secret rotation, 0 receiver mới.
- **`docker network create` cho scratch restore** — restore test không đụng prod docker networks, không risk mix container.
- **Alertmanager route order matters again** — placed onemcp matcher sau authway (không quan trọng thứ tự authway vs onemcp vì matcher exclusive), nhưng phải TRƯỚC `severity=critical` / `notify_style=event` để tránh hijack.

## Follow-up (không blocker)

- Sau 7 ngày (2026-08-28), xóa `/opt/onemcp/backups/*` local safety net khi tin cậy S3.
- Backend `onemcp_http_requests_total{status_code=...}` metric — verify label name khớp với Grafana panel query. Nếu label name khác (`status`, `code`) → update panel.
- OneMCP không có separate LDAP/external dependency probe như authway. Nếu future add Zitadel dependency mạnh → thêm blackbox probe `authway-vps` từ OneMCP.
