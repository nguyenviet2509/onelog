# OneMCP-vps Runbook

Host: `onemcp-vps` (private 10.200.0.44, public 202.92.5.113) · Owner: INet Ops
Break-glass: Grafana admin local `http://10.200.0.30/grafana/login`.

Related plan: [`plans/260821-1346-onemcp-monitor-backup-integration/`](../plans/260821-1346-onemcp-monitor-backup-integration/)
Convention: [`docs/observability-log-forwarding-convention.md`](observability-log-forwarding-convention.md)

## Repo layout on VPS

`/opt/onemcp` = git clone `https://github.com/nguyenviet2509/onemcp.git`. Two-way sync via git — sau bất kỳ SSH edit, commit local → push → `git reset --hard origin/master` VPS. Runtime files (`.env`, `.env.bak-*`, `ops/nginx/tls/`, `backups/`) gitignored.

## Quick health check

```bash
ssh onemcp-vps "cd /opt/onemcp && docker compose ps"
curl -sf http://10.200.0.44:3000/health
curl -sf http://10.200.0.44:3000/metrics | head -3
```

## Alert response

### `OnemcpBackendDown` <a id="backend-down"></a>

1. SSH onemcp-vps.
2. `docker compose ps backend` → nếu Exited/Restarting.
3. `docker logs onemcp-backend-1 --tail=100`.
4. Common:
   - Postgres unreachable → xem `OnemcpPostgresDown`.
   - OOM (Node.js heap): `dmesg | grep -i kill`. Tăng `BACKEND_MEM_LIMIT` trong `.env`.
   - Zitadel unreachable → auth fail → backend healthcheck fail. Check `AUTH_URL` reachable từ container.
5. Restart: `docker compose up -d backend`.
6. Verify: `curl http://10.200.0.44:3000/health`.

### `OnemcpPostgresDown` <a id="postgres-down"></a>

1. `docker compose ps postgres` → state.
2. `docker logs onemcp-postgres-1 --tail=50`.
3. Common: disk full, corruption, OOM, permission.
4. Disk full: `df -h /var/lib/docker`, kill old backup dirs `/opt/onemcp/backups/2026*` (giữ 3 gần nhất).
5. Corruption: restore từ snapshot S3 (xem `infra/backup/README.md` trong onemcp repo).
6. **CRITICAL:** không xóa `pg-data` volume nếu chưa có backup — pgvector data = skills + artifacts.

### `OnemcpNodeDown` / host unreachable <a id="host-down"></a>

1. `ping -c 3 10.200.0.44` từ onelog-vps.
2. Ping OK, scrape fail → node-exporter container down. Restart trong onemcp-vps.
3. Ping fail → VPS down hoặc private net partition. Cloud console kiểm tra.

### `OnemcpHttpsProbeFail` <a id="probe-fail"></a>

1. Test từ onelog-vps: `curl -v http://10.200.0.44:3000/health`.
2. Connection refused → backend down (xem `OnemcpBackendDown`).
3. 5xx → xem backend logs recent traceback.

### `OnemcpRedisDown` / `OnemcpBackend5xxSpike` / `OnemcpDisk*` / `OnemcpHost*`

Standard triage:
- Redis: `docker compose ps redis`, restart. Cache regenerable — không critical.
- 5xx: `docker logs onemcp-backend-1 --tail=200 | grep -iE "error|exception"`.
- Disk: `du -sh /var/lib/docker /opt/onemcp/backups /opt/onemcp/git-mirrors`.
- CPU/Mem: `docker stats --no-stream`.

## Backup schedule

Daily snapshot: `/opt/onemcp/ops/backup/snapshot-daily.sh`
- Cron: `0 2 * * *` (root crontab)
- Log: `/var/log/onemcp-snapshot.log`
- S3: `s3://backups-onemcp-server/daily/`
- Filename: `onemcp-YYYYMMDD-HHMM.tar.gz.age`
- Retention: 5 daily (`BACKUP_S3_KEEP_DAYS=5`)
- Encryption: age asymmetric — pubkey `ops/backup/backup-age.pub` (shared với OneLog master)

Contents:
- `globals.sql` — pg_dumpall roles + tablespaces
- `onemcp.sql.gz` — pg_dump `onemcp` DB (CREATE DATABASE included, pgvector extension)
- `minio-artifacts.tar.gz` — MinIO bucket mirror
- `git-mirrors.tar` — cached git skill mirrors
- `certbot-etc.tar` + `certbot-www.tar` — TLS certs
- `configs/` — docker-compose.yml + ops/nginx/ + ops/postgres/init.sql
- `secrets/` — .env + rendered configs
- `RESTORE.md` — step-by-step recovery
- `MANIFEST.json` + `SHA256SUMS`

Restore: xem `ops/backup/README.md` trong onemcp repo.

Manual run:
```bash
ssh onemcp-vps 'bash /opt/onemcp/ops/backup/snapshot-daily.sh'
```

## Break-glass access

Grafana OneLog nếu OIDC fail: `admin` local via `GRAFANA_ADMIN_PASSWORD` env.

## Related

- Plan monitor+backup: `plans/260821-1346-onemcp-monitor-backup-integration/`
- Sync policy: `.claude/rules/host-sync-policy.md`
