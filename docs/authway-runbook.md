# Authway-vps Runbook

Host: `authway-vps` (private 10.200.0.125) · Owner: INet Ops · Break-glass:
Grafana admin local (bypass OIDC) → `http://10.200.0.30/grafana/login`.

Related plan: [`plans/260821-1013-authway-vps-monitor-integration/`](../plans/260821-1013-authway-vps-monitor-integration/)
Convention: [`docs/observability-log-forwarding-convention.md`](observability-log-forwarding-convention.md)

## Quick health check

```bash
ssh authway-vps "cd /opt/authway/infra/authway-vps && docker compose ps"
curl -sf http://10.200.0.125/.well-known/openid-configuration | jq .issuer
curl -sf http://10.200.0.125:2112/debug/metrics | head -3
```

Cả 3 phải trả kết quả < 3s.

## Alert response

### `AuthwayZitadelDown` <a id="zitadel-down"></a>

1. SSH authway-vps.
2. `docker ps --filter name=authway-prod-zitadel-1 --format '{{.Status}}'` → nếu Exited hoặc Restarting:
3. `docker logs authway-prod-zitadel-1 --tail=100`
4. Common causes:
   - **Postgres unreachable** → xem `AuthwayPostgresDown` / cadvisor down alert.
   - **Config sai (sau upgrade)** → so sánh `/opt/authway/infra/authway-vps/zitadel-config.runtime.yaml` với repo baseline. Rollback nếu vừa change.
   - **OOM**: `dmesg | grep -i "killed process.*zitadel"`. Nếu OOM → tăng memory limit Docker + restart.
   - **DB migration failed** khi upgrade Zitadel version → xem log có `migration failed`.
5. Restart: `cd /opt/authway/infra/authway-vps && docker compose up -d zitadel`.
6. Verify: `curl http://10.200.0.125/.well-known/openid-configuration`.

### `AuthwayHttpsProbeFail` <a id="https-probe-fail"></a>

1. Test từ onelog-vps: `curl -v http://10.200.0.125/oauth/v2/keys`.
2. Nếu connection refused → Traefik down: `docker compose restart traefik`.
3. Nếu 5xx từ Zitadel → xem `AuthwayZitadelDown`.
4. Nếu chỉ 1 endpoint fail (VD `/oidc/v1/userinfo` return 5xx) → có thể bug Zitadel version, check upstream issues + downgrade.

### `AuthwayNodeDown` / host unreachable <a id="host-down"></a>

1. Ping từ onelog-vps: `ping -c 3 10.200.0.125`.
2. Nếu ping OK nhưng scrape fail → firewall / node_exporter container down.
   - `ssh authway-vps "docker ps --filter name=node-exporter"`.
   - Restart: `docker compose up -d node-exporter`.
3. Nếu ping fail → VPS down hoặc private net partition. Check cloud console + kb.inet.vn eth1 routing (memory: kb-inet-eth1-routing).
4. Nếu cả VPS chết → dùng cloud provider console để hard restart.

### `AuthwayPostgresDown` (implicit — cadvisor không thấy postgres container)

1. `docker ps --filter name=postgres --format '{{.Names}} {{.Status}}'`.
2. `docker logs authway-prod-postgres-1 --tail=100`.
3. Common: disk full, corruption, OOM, permission denied volume.
4. Nếu disk full: `df -h /var/lib/docker`, xóa WAL cũ, rotate.
5. Nếu corruption: restore từ backup (TODO: fill path sau khi setup pg_dump cron).
6. **CRITICAL:** Không xóa Postgres data — Zitadel event store = source of truth.

### `AuthwayLdapBindFail` <a id="ldap-fail"></a>

1. Không phải Zitadel down — new login qua LDAP fail, session active vẫn OK.
2. Test LDAP từ authway-vps: `nc -zv 103.57.220.98 389` hoặc `curl -sI http://103.57.220.98:389 --max-time 5`.
3. Nếu unreachable → phone Zimbra ops team. Ngoài scope INet Ops.
4. Workaround: user cần login gấp có thể dùng local Zitadel account (nếu đã tạo).

### `AuthwayCertExpiringSoon`

1. Hiện tại authway-vps chạy HTTP-only (no Traefik ACME). Alert này chỉ fire nếu sau này bật HTTPS.
2. Nếu bật: `docker logs authway-prod-traefik-1 | grep -i acme` để check renewal error.

### `AuthwayDiskLow` / `AuthwayHostCpuHigh` / `AuthwayHostMemoryHigh`

Host capacity — standard triage:
- CPU: `docker stats --no-stream` → find top container.
- Memory: same. Nếu Zitadel → tune `ZITADEL_LOG_LEVEL` xuống, tăng RAM VPS.
- Disk: `du -sh /var/lib/docker /opt/authway /var/log` → xóa log cũ.

## Break-glass Grafana access

Nếu Grafana onelog-vps cũng gate qua OIDC Authway → basic auth bypass:

- URL: `http://10.200.0.30/grafana/login`
- User: `admin`, password: env `GRAFANA_ADMIN_PASSWORD` trong `/opt/onelog/infra/.env`.
- Reference commit: `aac7d0b feat(grafana): bật basic auth cho break-glass + API access`.

Nếu SSH authway-vps mất → cloud console để access (Vultr/GCP dashboard).

## Backup schedule

TODO: chưa có cron pg_dump chính thức. Follow-up trong plan riêng.

## Related

- `authway-architecture-endstate-guide.html` — kiến trúc 2-VPS
- `authway-rbac-guide.html` — RBAC + config
- Plan monitor: `plans/260821-1013-authway-vps-monitor-integration/`
- Sync policy: `.claude/rules/host-sync-policy.md`
