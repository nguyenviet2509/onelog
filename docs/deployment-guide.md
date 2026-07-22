# Deploy OneLog RAG Log Server (Lab 3-VM)

> Plan `260622-1056-rag-logserver-victorialogs` · deploy stack lên `logserver` + wire 2 client VM forward syslog.
> Verified trên `logserver-01` (Ubuntu 24.04).

## Golden rules

1. `docker compose ...` **luôn chạy từ `~/onelog/infra`**. Đứng ở `~/onelog` sẽ báo `no configuration file provided`.
2. Repo clone vào `~/onelog` (user home), KHÔNG `/opt/onelog`. Scripts auto-detect qua `$SCRIPT_DIR`.
3. Services có profile — luôn kèm flag: `--profile agent`, `--profile mcp`, `--profile alerts`, `--profile indexer`.
4. NTP sync bắt buộc trước khi ingest — timestamp lệch = trace vỡ.
5. Sau khi `usermod -aG docker` phải **re-login** hoặc `newgrp docker` mới dùng compose không cần sudo.
6. **KHÔNG hotfix trực tiếp trên server**. Edit vào repo local → commit → push → pull → apply. Session 2026-07-13 phát hiện 4 file drift do vi phạm rule này → suýt mất khi deploy lại. Nếu buộc phải hotfix (incident, chưa kịp PR): `git diff` chụp lại, mở issue commit về sau, KHÔNG để drift > 24h.
7. **KHÔNG commit secrets/dumps**. `.gitignore` đã cover `backups/`, `*.sql`, `*.env.bak`, `.env.bak-*`. Nếu cần archive DB dump / env backup → upload offsite (S3/1Password), không git.

---

## Topology

```
LAB SUBNET 192.168.122.0/24
  ┌──────────────────────────────────────────────────────────┐
  │  srv-01 (.52)              srv-02 (.51)                   │
  │  rsyslog / vector-agent    rsyslog / vector-agent         │
  │       │                          │                        │
  │       └──── syslog TCP 6514 ─────┘                        │
  │                    │                                       │
  │                    ▼                                       │
  │  logserver (.53) — docker compose stack                    │
  │    vector       514/udp, 6514/tcp, 8686 api                │
  │    victorialogs 9428 (127.0.0.1)                           │
  │    qdrant       6333 (127.0.0.1)                           │
  │    postgres     5432 (127.0.0.1)                           │
  │    redis, nats, indexer, mcp-vl, mcp-semantic (internal)   │
  │    agent        8080 (127.0.0.1, sau caddy /api)           │
  │    caddy        80, 443 (IP whitelist LAN)                 │
  └──────────────────────────────────────────────────────────┘
```

Lab mode:
- Caddy `tls internal` (self-signed) hoặc HTTP only
- No auth — IP whitelist trong Caddyfile
- Syslog TCP 6514 (RFC5424) giữa VM; UDP 514 chỉ smoke local

---

## Quick deploy — logserver

Copy-paste theo thứ tự trên `logserver` (192.168.122.53, user với sudo):

```bash
# 1. Base packages + NTP
sudo apt-get update
sudo apt-get install -y curl wget git ca-certificates ufw chrony age
sudo systemctl enable --now chrony
sudo timedatectl set-timezone Asia/Saigon

# 2. Clone repo vào home
cd ~
git clone <repo-url> onelog
cd ~/onelog

# 3. One-shot setup: Docker CE + UFW + docker group + hosts fix
sudo INVOKING_USER=$USER LAN_CIDR=192.168.122.0/24 \
  bash infra/scripts/setup-log-server.sh

# 4. Re-login để group docker có hiệu lực
exit
# ssh lại vào server, chạy tiếp:
cd ~/onelog/infra
docker ps    # phải work không cần sudo

# 5. Gen secrets, paste vào .env
cp .env.example .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "QDRANT_API_KEY=$(openssl rand -hex 24)"
echo "REDIS_PASSWORD=$(openssl rand -hex 24)"
vi .env    # paste secrets + provider API keys (nếu có)

# 6. Render VM scrape config (secrets from .env → scrape.yml)
bash infra/scripts/render-scrape.sh

# 7. (Optional) sub-path deploy behind Caddy at bare-IP endpoints
cp infra/docker-compose.override.yml.example infra/docker-compose.override.yml
# edit GF_SERVER_ROOT_URL to your VPS reachable URL

# 8. Deploy full stack (all profiles + host monitoring)
PROFILES="--profile agent --profile mcp --profile alerts --profile indexer \
--profile chat --profile llm --profile dashboard --profile monitoring"
docker compose $PROFILES pull
docker compose $PROFILES up -d
sleep 30
docker compose $PROFILES ps

# 9. Systemd auto-restart
sudo bash infra/scripts/install-systemd-unit.sh
sudo systemctl status ragstack --no-pager
```

### Access URLs (bare-IP deploy)

| Path | Service |
|---|---|
| `http://<vps-ip>/` | OpenWebUI (chat) |
| `http://<vps-ip>/grafana/` | Grafana (login: admin / `$GRAFANA_ADMIN_PASSWORD`) |
| `http://<vps-ip>/vmui/` | VictoriaLogs UI |
| `http://<vps-ip>/llm/v1/*` | LiteLLM proxy (Bearer master key) |
| `http://<vps-ip>/mcp/vl/`, `/mcp/semantic/` | MCP servers (Bearer) |
| `<vps-ip>:514/udp`, `:6514/tcp` | Syslog ingest |

Nếu deploy thêm LLM abstraction (LiteLLM + OpenWebUI), xem [deployment-llm-abstraction.md](deployment-llm-abstraction.md).

## Optional · Cost dashboard

Dashboard xem cost/quota realtime cho 4 LLM provider (Anthropic, OpenAI, DeepSeek, Gemini). Deploy sau khi stack chính OK · Phase A tốn ~5 phút · Phase B thêm 15 phút khi có admin key.

Xem chi tiết: [cost-dashboard.md](cost-dashboard.md) — bring-up 5 lệnh + admin key rotate SOP.

---

## Config .env (block chính)

```env
# Domain (lab: dùng IP)
APP_DOMAIN=app.local
ALLOWED_CIDR=192.168.122.0/24

# Datastore secrets — paste từ openssl rand
QDRANT_API_KEY=<paste>
REDIS_PASSWORD=<paste>

# LLM (agent service — LiteLLM SDK direct)
# Chi tiết trong deployment-llm-abstraction.md
LLM_MODEL=anthropic/claude-sonnet-4-5
LLM_MOCK=true                    # false khi có key thật
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Telegram (optional, alerts phase)
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALERT_CHAT_ID=
TELEGRAM_MOCK=true

# VictoriaLogs retention
VL_RETENTION=7d

# Caddy TLS
CADDY_TLS=internal

# MCP bearer tokens (format: user1:token1,user2:token2)
MCP_BEARER_TOKENS=
MCP_ALLOW_ANON=false
VMUI_BASE_URL=http://app.local
```

---

## Knowledge Base

KB workflow uses OpenWebUI native features (sidebar Notes + Workspace → Knowledge). No custom service, Postgres decommissioned. See [docs/openwebui-user-guide.md](openwebui-user-guide.md).

---

## Snapshot daily

```bash
sudo install -m 0755 -d ~/onelog/backup
(crontab -l 2>/dev/null; \
 echo "0 2 * * * $HOME/onelog/infra/scripts/snapshot-daily.sh >> /var/log/ragstack-snapshot.log 2>&1") \
 | crontab -

# Test ngay
bash ~/onelog/infra/scripts/healthcheck.sh
bash ~/onelog/infra/scripts/snapshot-daily.sh
ls -lh ~/onelog/backup/
```

---

## Quick deploy — client (srv-01, srv-02)

Trên workstation (có SSH tới cả log server + clients):

```bash
# Copy setup script sang client
scp ~/onelog/infra/scripts/setup-rsyslog-client.sh user@192.168.122.52:/tmp/
ssh user@192.168.122.52

# Trên client
sudo LOG_SERVER_IP=192.168.122.53 bash /tmp/setup-rsyslog-client.sh
```

Script tự:
- Cài rsyslog nếu thiếu
- Backup config cũ conflict (`*-forward*.conf`, `*-onelog*.conf`)
- Drop `90-forward-onelog.conf` với template RFC5424 (Vector strict parser)
- Verify TCP ESTABLISHED tới `logserver:6514`
- Fire smoke log `service:client-onboard`

**Tại sao TCP 6514 (không UDP 514):**
- Vector reject RFC3164 default (thiếu year + tz) → cần RFC5424
- TCP có disk queue resume khi log server restart
- 6514 để mở đường TLS sau này (chưa enable ở lab)

**Option Vector agent** (buffer disk + TLS ready) — xem [infra/clients/](../infra/clients/) hoặc chạy manual theo doc Vector.

---

## Smoke test (theo thứ tự)

```bash
# 1. Stack health
cd ~/onelog/infra
docker compose --profile agent --profile mcp --profile alerts --profile indexer ps
curl -fsS http://localhost:9428/health && echo " VL OK"
docker exec ragstack-postgres pg_isready -U rag
docker exec ragstack-redis redis-cli -a "$REDIS_PASSWORD" ping

# 2. Ingest path — từ srv-01
ssh user@192.168.122.52 'logger -t e2e-test "trace-id=abc123 user=alice ok"'
sleep 5
curl -fsS 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=e2e-test trace-id=abc123' | jq .
# → 1 record, host=srv-01, message chứa abc123

# 3. Redaction (PII strip)
ssh user@192.168.122.52 'logger -t redact-test "email=alice@example.com ip=10.0.0.5 token=Bearer eyJx.y.z"'
sleep 5
curl -fsS 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=redact-test' | jq -r '.[] | .message'
# → KHÔNG có PII gốc; phải thấy <EMAIL>, <IP>, <JWT>

# 4. Indexer → Qdrant
ssh user@192.168.122.52 'for i in $(seq 1 200); do
  logger -p user.warn -t app-x "Connection reset by peer service=api-$((i%5))"
done'
sleep 120
curl -fsS -H "api-key: $QDRANT_API_KEY" \
  "http://localhost:6333/collections/log_templates" | jq '.result.points_count'
# → > 0 (Drain3 gom ≤ 5 template)

# 5. Agent /chat SSE
curl -N -X POST http://localhost:8080/chat \
  -H 'Content-Type: application/json' \
  -d '{"query":"Có lỗi connection reset không?"}' | head -30
# → SSE events: thinking, tool_call, tool_result, answer
# → LLM_MOCK=true dùng canned response; key thật trả answer thực

# 6. Alert smoke (nếu profile alerts up)
docker exec ragstack-alertmanager amtool alert add TestAlert \
  severity=critical service=api-1 --annotation="summary=Smoke alert"
# → Telegram chat nhận message (nếu bot token set + MOCK=false)
```

---

## Verification checklist

- [ ] 3 VM ping nhau, `chronyc tracking` OK
- [ ] `docker compose ps` toàn healthy
- [ ] `logger` từ srv-01, srv-02 xuất hiện trong VL < 10s
- [ ] Redaction test: 0 leak PII
- [ ] Qdrant `log_templates.points_count > 0` sau load test
- [ ] Agent `/chat` SSE trả events có citation
- [ ] `bash infra/scripts/healthcheck.sh` → 0 failure
- [ ] `bash infra/scripts/snapshot-daily.sh` tạo `~/onelog/backup/onelog-YYYYMMDD-HHMM.tar.gz`
- [ ] Restore dry-run: `bash infra/scripts/restore-snapshot.sh <archive>` → stack up lại
- [ ] Reboot logserver → `systemctl status ragstack` healthy

### Verify Docker log rotate (post plan 260710-1432 phase 01)

```bash
# Daemon config
cat /etc/docker/daemon.json | jq '.["log-opts"]'
# Expect: {"max-size": "10m", "max-file": "3"}

# Per-container applied
for c in $(docker compose ps -q); do
  docker inspect --format '{{.Name}} → {{.HostConfig.LogConfig.Config}}' $c
done
# Expect: mọi container có max-size:10m (litellm override max-file:5 vẫn OK)
```

Nếu container chưa có config (chạy trước khi apply daemon.json), recreate:
`docker compose up -d --force-recreate <service>`

### Verify disk alerts (post plan 260710-1432 phase 02)

```bash
# vmalert loaded 5 rules disk-alerts
curl -s http://127.0.0.1:8880/api/v1/rules | \
  jq '.data.groups[] | select(.name=="disk-alerts") | .rules[] | {alert, state}'
# Expect: DiskDataHighWarn/Crit, DiskRootHighWarn/Crit, DiskProbeStale — state=inactive baseline

# Probe emit
curl -s "http://127.0.0.1:9428/select/logsql/query" \
  --data-urlencode 'query=service:logserver-disk-monitor _time:10m | limit 3' | jq .
curl -s "http://127.0.0.1:9428/select/logsql/query" \
  --data-urlencode 'query=service:host-disk-monitor _time:10m | limit 3' | jq .
# Cả 2 phải return ≥ 1 event với used_pct numeric.

# Host cron cài đặt
crontab -l | grep onelog-probe-host-disk
# Expect: */5 * * * * ... /usr/local/bin/onelog-probe-host-disk.sh
```

Force-test (primary — không đụng disk):

```bash
# Tạm hạ threshold DiskDataHighWarn → wait 20 phút → verify Telegram receive
sed -i.bak 's/filter value:>75/filter value:>1/' infra/vmalert/rules.yml
docker compose --profile alerts restart vmalert
# Chờ 20 phút, verify Telegram Issue alert topic nhận DiskDataHighWarn.
# Restore:
mv infra/vmalert/rules.yml.bak infra/vmalert/rules.yml
docker compose --profile alerts restart vmalert
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no configuration file provided: not found` | `cd ~/onelog/infra` trước khi chạy `docker compose` |
| `no such service: X` | Thêm `--profile agent` / `mcp` / `alerts` / `indexer` |
| `apt install docker-compose-plugin` conflict `docker-compose-v2` | Chạy lại `setup-log-server.sh` — auto purge conflict trước |
| Docker daemon fail `metadata.db: no such file or directory` | `sudo RESET_DOCKER=1 bash setup-log-server.sh` (nuke `/var/lib/{docker,containerd}` reinstall) |
| `permission denied ... docker.sock` | `sudo usermod -aG docker $USER && newgrp docker` (hoặc re-login) |
| Vector restart loop, `Missing environment variable name = "1"` | VRL `$1` bị YAML env-var nuốt — đã fix trong `vector.yaml` (dùng literal replacement) |
| `logger` không thấy trong VL, Vector log `Failed deserializing frame` | rsyslog default RFC3164 thiếu year+tz. Dùng `setup-rsyslog-client.sh` (RFC5424 template) |
| Browser `:9428/select/vmui/` timeout | VL bind loopback. Vào qua Caddy: `http://<vm-ip>/vmui/` |
| vmui "Failed to load stream fields - 404" | Caddy thiếu proxy `/select/*` — đã fix trong Caddyfile |
| `healthcheck.sh` báo `disk ?% used` | `INFRA_DIR` default sai — script auto-detect qua `$SCRIPT_DIR` |
| `sudo: unable to resolve host srv-XX` | Cosmetic. Setup script tự add `127.0.1.1 $(hostname)` vào /etc/hosts |
| `git pull` báo `local changes would be overwritten` | `git stash push && git pull && git stash pop` (hoặc drop stash nếu không cần) |
| Qdrant 401 | `QDRANT_API_KEY` mismatch giữa indexer + qdrant `.env`, restart cả 2 |
| Indexer lag > 5 phút | `docker stats indexer` — tăng batch size hoặc check OpenAI rate limit |
| Agent `/chat` 5xx | `docker compose logs agent` — thường thiếu key hoặc Postgres down |
| Caddy 502 backend | `docker compose logs caddy <service>` — service unhealthy hoặc network name mismatch |
| TLS warning browser (lab) | Bình thường (self-signed). Production: dùng domain + LE cert |

Log tổng hợp mọi lỗi 10 phút qua:
```bash
docker compose --profile agent --profile mcp --profile alerts --profile indexer \
  logs --since=10m | grep -iE 'error|panic|fatal'
```

---

## Rollback / cleanup

```bash
cd ~/onelog/infra

# Dừng stack, giữ data
docker compose --profile agent --profile mcp --profile alerts --profile indexer down

# Xóa toàn bộ data (CẨN THẬN — không undo được)
docker compose --profile agent --profile mcp --profile alerts --profile indexer down -v
sudo rm -rf ~/onelog/infra/data/{victorialogs,qdrant,postgres,redis}

# Restore từ snapshot
bash ~/onelog/infra/scripts/restore-snapshot.sh \
  ~/onelog/backup/onelog-YYYYMMDD-HHMM.tar.gz
```

Trên client:
```bash
sudo rm /etc/rsyslog.d/90-forward-onelog.conf
sudo systemctl restart rsyslog
# hoặc nếu dùng Vector agent:
sudo systemctl disable --now vector
```

---

## Lab → Production checklist

- [ ] Thay `tls internal` bằng domain thật + Let's Encrypt
- [ ] Bật auth (OIDC / bearer) — gỡ IP whitelist
- [ ] Syslog TCP 6514 + client TLS cert (thay UDP 514)
- [ ] Snapshot offsite (MinIO/S3) — thay local `~/onelog/backup`
- [ ] Monitoring: Prometheus scrape `/metrics` vector + indexer + agent
- [ ] Phase 07 HA roadmap review
- [ ] Deploy LLM abstraction ([deployment-llm-abstraction.md](deployment-llm-abstraction.md)) nếu team migrate khỏi Claude Desktop

---

## Unresolved / defer

1. Lab DNS internal có sẵn không? Nếu có, set `APP_DOMAIN=onelog.lab` thay IP raw.
2. Client log volume để pick rsyslog vs Vector agent — hiện default rsyslog cho tất cả.
3. MinIO/NAS subnet cho snapshot offsite — hiện local-only.
4. OpenAI/Anthropic egress: lab có HTTPS proxy hay direct — set `HTTPS_PROXY` trong `.env` nếu cần.
