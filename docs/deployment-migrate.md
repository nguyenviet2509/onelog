# Migrate OneLog sang VPS mới — Runbook target VPS

> Toàn bộ lệnh chạy trên target VPS (`192.168.122.56`). Kịch bản mặc định: **B (giữ data cũ qua snapshot restore)**. Nếu fresh start (A) → có note skip ở step 6, step 8, step 12.

## Prereq (đã hoàn tất trên source + workstation)

- Source đã snapshot: `bash ~/onelog/infra/scripts/snapshot-daily.sh` → sinh `~/onelog/backup/onelog-YYYYMMDD-HHMM.tar.gz`
- Source đã stop stack: `docker compose --profile agent --profile mcp --profile alerts --profile indexer stop`
- Archive + `.env` đã rsync/scp sang target:
  - Archive: `~/onelog/backup/onelog-*.tar.gz`
  - Env: `/tmp/onelog.env.migrate`
- Commit hash source (từ `git rev-parse HEAD`) đã ghim để paste vào step 3

---

## 1. SSH vào target lần đầu

```bash
ssh vietnt@192.168.122.56
```

## 2. Base packages + NTP

```bash
sudo apt-get update
sudo apt-get install -y curl wget git ca-certificates ufw chrony age rsync
sudo systemctl enable --now chrony
sudo timedatectl set-timezone Asia/Saigon

# Verify NTP sync (quan trọng cho log timestamp)
chronyc tracking
```

## 3. Clone repo — đúng commit hash source

```bash
cd ~
git clone https://github.com/nguyenviet2509/onelog.git
cd ~/onelog

# Paste commit hash lấy từ source (git rev-parse HEAD)
git checkout <PASTE_COMMIT_HASH>

# Verify
git log -1 --oneline
```

## 4. One-shot setup: Docker + UFW + docker group + hosts fix

```bash
sudo INVOKING_USER=$USER LAN_CIDR=192.168.122.0/24 \
  bash infra/scripts/setup-log-server.sh
```

## 5. Re-login để group docker có hiệu lực

```bash
exit
# ssh lại
ssh vietnt@192.168.122.56

# Verify docker chạy không cần sudo
docker ps
docker compose version
```

## 6. Import .env

**Kịch bản B (giữ data cũ)** — copy từ source:

```bash
mv /tmp/onelog.env.migrate ~/onelog/infra/.env
chmod 600 ~/onelog/infra/.env

# Verify secrets present
grep -cE '^(POSTGRES_PASSWORD|QDRANT_API_KEY|REDIS_PASSWORD)=' ~/onelog/infra/.env
# → phải in ra "3"
```

**Kịch bản A (fresh start)** — gen secrets mới:

```bash
cd ~/onelog/infra
cp .env.example .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "QDRANT_API_KEY=$(openssl rand -hex 24)"
echo "REDIS_PASSWORD=$(openssl rand -hex 24)"
vi .env    # paste 3 secrets trên + LLM API keys + Telegram tokens
chmod 600 .env
```

## 7. Pull docker images (chưa up)

```bash
cd ~/onelog/infra
docker compose --profile agent --profile mcp --profile alerts --profile indexer pull
```

## 8. Restore data từ snapshot

**Kịch bản A (fresh start)** — SKIP step 8, nhảy thẳng step 9.

**Kịch bản B (giữ data cũ)**:

```bash
cd ~/onelog/infra
ls -lht ~/onelog/backup/
ARCHIVE=$(ls -t ~/onelog/backup/onelog-*.tar.gz | head -1)
echo "Restoring from: $ARCHIVE"

# Script tự stop victorialogs/qdrant/postgres, xả data, restore, up stack
FORCE=1 bash scripts/restore-snapshot.sh "$ARCHIVE"
```

## 9. Up toàn stack

```bash
cd ~/onelog/infra
docker compose --profile agent --profile mcp --profile alerts --profile indexer up -d
sleep 30
docker compose --profile agent --profile mcp --profile alerts --profile indexer ps
```

## 10. Systemd auto-restart

```bash
sudo bash ~/onelog/infra/scripts/install-systemd-unit.sh
sudo systemctl status ragstack --no-pager
```

## 11. Healthcheck

```bash
bash ~/onelog/infra/scripts/healthcheck.sh

# Manual verify
curl -fsS http://localhost:9428/health && echo " VL OK"
docker exec ragstack-postgres pg_isready -U rag
source ~/onelog/infra/.env && docker exec ragstack-redis redis-cli -a "$REDIS_PASSWORD" ping
```

## 12. Verify data restored

**Kịch bản A (fresh start)** — SKIP step 12.

**Kịch bản B**:

```bash
# VictoriaLogs count
curl -s "http://localhost:9428/select/logsql/query" \
  --data-urlencode 'query=* _time:24h | stats count() as c' | head

# Qdrant collections
source ~/onelog/infra/.env
curl -s -H "api-key: $QDRANT_API_KEY" http://localhost:6333/collections | \
  grep -oE '"name":"[^"]+"'

# Postgres tables
docker exec ragstack-postgres psql -U rag -d rag -c '\dt'
```

## 13. Setup snapshot cron

```bash
mkdir -p ~/onelog/backup
(crontab -l 2>/dev/null; \
 echo "0 2 * * * $HOME/onelog/infra/scripts/snapshot-daily.sh >> /var/log/ragstack-snapshot.log 2>&1") \
 | crontab -
crontab -l
```

## 14. Reboot test

```bash
sudo reboot
# Chờ 30s, ssh lại:
ssh vietnt@192.168.122.56
sudo systemctl status ragstack --no-pager
docker ps
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Step 4 `apt install docker-compose-plugin` conflict | Chạy lại `setup-log-server.sh` — auto purge conflict trước |
| Step 5 `permission denied ... docker.sock` | `sudo usermod -aG docker $USER && newgrp docker` (hoặc re-login lại) |
| Step 6 verify count ≠ 3 | `.env` copy thiếu — scp lại từ source. Nếu source mode 600 → `chmod 644` tạm |
| Step 8 restore script `no such service` | Chạy từ `~/onelog/infra`, không phải `~/onelog` |
| Step 8 Qdrant snapshot upload 401 | `QDRANT_API_KEY` giữa source `.env` và target `.env` phải giống nhau |
| Step 8 Postgres restore `role "rag" does not exist` | `.env` không load — check `POSTGRES_USER=rag` present và mode 600 |
| Step 9 container restart loop | `docker compose logs <service>` — thường LLM key / secret thiếu trong `.env` |
| Step 11 agent /chat 5xx | `docker compose logs agent` — verify `grep ANTHROPIC_API_KEY .env` |
| Step 12 VL count = 0 | Check `infra/data/victorialogs/` có unpacked chưa (`ls -la`); rỗng → rerun step 8 |
| Step 10 systemd unit fail | `sudo journalctl -u ragstack -n 100` — path `WorkingDirectory` sai vì repo clone khác chỗ |
| UFW block traffic clients | `sudo ufw status | grep 6514` — allow từ `192.168.122.0/24` |

---

## Rollback (nếu target fail bất kỳ step nào)

```bash
# Trên source — restart stack, phục hồi service
ssh vietnt@192.168.122.53
cd ~/onelog/infra
docker compose --profile agent --profile mcp --profile alerts --profile indexer start
docker compose --profile agent --profile mcp --profile alerts --profile indexer ps
```

Clients (nếu đã switch một số) → rerun `deploy-client.sh --log-server-ip 192.168.122.53`.

---

## Post-migrate cleanup source (chỉ sau target healthy ≥ 24h)

```bash
# Trên source
cp ~/onelog/infra/.env ~/onelog.env.decommissioned-$(date +%F)
# Upload backup .env lên nơi an toàn (1Password/S3)

sudo systemctl disable --now ragstack
cd ~/onelog/infra
docker compose --profile agent --profile mcp --profile alerts --profile indexer down -v
sudo rm -rf ~/onelog/infra/data
```

**KHÔNG xóa gì trên source cho đến khi:**
1. Target chạy healthy ≥ 24h
2. Ít nhất 1 lần `snapshot-daily.sh` chạy thành công trên target
3. Verified log ingest đầy đủ (nếu đã switch clients)

---

## Unresolved

- Vector queue on-disk buffer (nếu enable) — snapshot KHÔNG cover. Log trong buffer khi source down = mất. Chấp nhận cho use case này (client rsyslog TCP retry sẽ resend).
- Chưa có script `migrate.sh` tự động hóa 14 step — hiện copy-paste manual.
- Clients switch qua target IP (`192.168.122.56`) — out of scope, cần tài liệu riêng batch re-run `deploy-client.sh`.
