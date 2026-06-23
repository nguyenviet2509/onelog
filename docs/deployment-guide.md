# Deployment Guide — OneLog RAG Log Server (Lab 3-VM)

> Hướng dẫn deploy + smoke test sau khi "cook" xong plan `260622-1056-rag-logserver-victorialogs` trên lab 3 VM nội bộ.

## 1. Topology

```
┌─────────────────────────────────────────────────────────────────┐
│  LAB SUBNET 192.168.122.0/24                                    │
│                                                                 │
│   srv-01 (192.168.122.52)         srv-02 (192.168.122.51)       │
│   ─ rsyslog / vector-agent         ─ rsyslog / vector-agent     │
│           │                                │                    │
│           └──────── syslog 514/udp ────────┘                    │
│                          │                                      │
│                          ▼                                      │
│   logserver (192.168.122.53)                                    │
│   ─ docker compose stack:                                       │
│       vector  : 514/udp, 6514/tcp-tls, 8686 api                 │
│       victorialogs : 9428                                       │
│       qdrant       : 6333 (127.0.0.1)                           │
│       postgres     : 5432 (127.0.0.1)                           │
│       redis        : 6379 (127.0.0.1)                           │
│       nats         : 4222 (127.0.0.1)                           │
│       indexer      : internal                                   │
│       rag-agent    : 8000 (internal, sau caddy /api)            │
│       web (next)   : 3000 (internal, sau caddy /)               │
│       caddy        : 80, 443  (IP whitelist 192.168.122.0/24)   │
└─────────────────────────────────────────────────────────────────┘
```

Lab mode quyết định:
- **No public DNS / Let's Encrypt** → Caddy dùng `tls internal` (self-signed) hoặc HTTP only cho test.
- **No auth** (defer per plan) → IP whitelist subnet trong Caddyfile.
- Syslog UDP 514 plaintext giữa các VM (subnet trust); TLS 6514 optional.

---

## 2. Pre-requisites mỗi VM

Cả 3 VM (Ubuntu 22.04/24.04 LTS):

```bash
sudo apt-get update
sudo apt-get install -y curl wget git ca-certificates ufw
sudo timedatectl set-timezone Asia/Saigon
```

NTP sync (bắt buộc — log timestamp lệch sẽ phá trace):
```bash
sudo apt-get install -y chrony && sudo systemctl enable --now chrony
chronyc tracking | head -3
```

---

## 3. Deploy logserver (192.168.122.53)

### 3.1 SSH + hardening

```bash
ssh root@192.168.122.53
adduser ragops && usermod -aG sudo ragops
# copy ssh key cho ragops, disable password login /etc/ssh/sshd_config:
#   PasswordAuthentication no
sudo systemctl restart ssh
```

### 3.2 One-shot setup script (Docker + UFW + system tuning)

Thay vì làm tay từng bước, dùng script idempotent đã verify trên Ubuntu 24.04:

```bash
# Clone repo trước
sudo mkdir -p /opt/onelog && sudo chown $USER:$USER /opt/onelog
cd /opt/onelog
git clone <repo-url> .

# Chạy setup (cần sudo, tự pass INVOKING_USER để add docker group)
sudo INVOKING_USER=$USER LAN_CIDR=192.168.122.0/24 bash infra/scripts/setup-log-server.sh
```

Script này tự:
- Cài Docker CE + compose plugin (gỡ `docker-compose-v2` / `docker.io` của Ubuntu nếu conflict)
- Recover từ docker.io → docker-ce transition fail (gợi ý `RESET_DOCKER=1` khi containerd hỏng)
- Mở UFW chỉ cho LAN CIDR
- Thêm `$USER` vào docker group
- Sync NTP + fix `/etc/hosts` cho hostname
- In ra secrets random để paste vào `.env`

> **Quan trọng**: sau khi script chạy xong, **re-login** (hoặc `newgrp docker`) để group docker có hiệu lực, rồi mới `docker compose up` được không cần sudo.

### 3.4 Clone repo + secrets

```bash
sudo mkdir -p /opt/onelog && sudo chown ragops:ragops /opt/onelog
cd /opt/onelog
git clone <repo-url> .
cp infra/.env.example infra/.env
```

Edit `infra/.env`:
```env
# Domain (lab: dùng IP)
APP_DOMAIN=192.168.122.53
ALLOWED_CIDR=192.168.122.0/24

# Datastore secrets — sinh random
POSTGRES_PASSWORD=$(openssl rand -hex 24)
QDRANT_API_KEY=$(openssl rand -hex 24)
REDIS_PASSWORD=$(openssl rand -hex 24)

# LLM
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Telegram (optional Phase 06, để trống nếu chưa cần)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Lab: bỏ TLS LE
CADDY_TLS=internal
```

> Lưu ý: lệnh `$(openssl ...)` chỉ là gợi ý sinh giá trị — phải paste giá trị tĩnh vào `.env`.

### 3.5 Khởi động stack

```bash
cd /opt/onelog/infra
docker compose pull
docker compose up -d
docker compose ps
```

Kỳ vọng tất cả service `healthy`:
```
victorialogs   healthy
qdrant         healthy
postgres       healthy
redis          healthy
nats           healthy
vector         healthy
indexer        healthy
rag-agent      healthy
web            healthy
caddy          running
```

Tail log nếu service nào restart:
```bash
docker compose logs -f --tail=100 <service>
```

### 3.6 systemd auto-restart

Dùng installer tự detect path + user:

```bash
sudo bash infra/scripts/install-systemd-unit.sh
# Tạo /etc/onelog-ragstack.env + enable ragstack.service
# KHÔNG start ngay nếu stack đang chạy thủ công — chờ reboot để verify
```

Verify khi reboot lần kế (hoặc thử manual):
```bash
sudo systemctl status ragstack --no-pager
sudo cat /etc/onelog-ragstack.env
```

### 3.7 Snapshot daily (cron)

```bash
sudo install -m 0755 -o ragops -g ragops -d /opt/onelog/backup
sudo install -m 0755 infra/scripts/snapshot-daily.sh /opt/onelog/infra/scripts/snapshot-daily.sh
sudo install -m 0755 infra/scripts/restore-snapshot.sh /opt/onelog/infra/scripts/restore-snapshot.sh
sudo install -m 0755 infra/scripts/healthcheck.sh    /opt/onelog/infra/scripts/healthcheck.sh

# Crontab cho user ragops
(crontab -l 2>/dev/null; echo "0 2 * * * /opt/onelog/infra/scripts/snapshot-daily.sh >> /var/log/ragstack-snapshot.log 2>&1") | crontab -

# Smoke test ngay
bash /opt/onelog/infra/scripts/healthcheck.sh
bash /opt/onelog/infra/scripts/snapshot-daily.sh
ls -lh /opt/onelog/backup/
```

---

## 4. Cấu hình client server (192.168.122.51 và 192.168.122.52)

### 4.1 Option A — rsyslog (recommend, production-ready)

Dùng script tự động (TCP 6514 + RFC5424 + disk queue):

```bash
# Clone hoặc copy infra/scripts/setup-rsyslog-client.sh sang client
scp infra/scripts/setup-rsyslog-client.sh user@<client-ip>:/tmp/
ssh user@<client-ip>
sudo LOG_SERVER_IP=192.168.122.53 bash /tmp/setup-rsyslog-client.sh
```

Script tự:
- Cài rsyslog nếu thiếu
- Backup mọi forwarder conflict cũ (`*-forward*.conf`, `*-onelog*.conf`)
- Drop `90-forward-onelog.conf` với template RFC5424 (Vector strict parser yêu cầu)
- Syntax check, restart rsyslog, verify TCP ESTABLISHED tới logserver:6514
- Fire smoke log `service:client-onboard`

**Tại sao TCP 6514, không phải UDP 514**:
- Vector syslog parser strict — reject RFC3164 default của rsyslog (no year + tz)
- Cần RFC5424 template `<%PRI%>1 %TIMESTAMP:::date-rfc3339% ...`
- TCP cho reliable delivery + disk queue resume khi logserver restart

### 4.2 Option B — Vector agent (khuyến nghị production, có buffer disk + TLS)

```bash
curl -1sLf 'https://repositories.timber.io/public/vector/cfg/setup/bash.deb.sh' | sudo -E bash
sudo apt-get install -y vector

sudo tee /etc/vector/vector.yaml >/dev/null <<'EOF'
sources:
  journald_in:
    type: journald
    current_boot_only: true
  syslog_in:
    type: file
    include: ["/var/log/syslog", "/var/log/auth.log"]

transforms:
  enrich:
    type: remap
    inputs: [journald_in, syslog_in]
    source: |
      .host = get_hostname!()
      .env = "lab"

sinks:
  to_logserver:
    type: vector
    inputs: [enrich]
    address: "192.168.122.53:6000"   # vector-to-vector port (mở thêm nếu dùng)
    buffer:
      type: disk
      max_size: 1073741824           # 1GB
EOF

sudo systemctl enable --now vector
sudo systemctl status vector
```

> Nếu chọn Option B: nhớ mở thêm port 6000/tcp trên logserver UFW + thêm source `vector` trong `vector.yaml` của logserver.

---

## 5. Smoke tests (theo thứ tự)

Chạy từ logserver hoặc workstation có route tới 192.168.122.0/24.

### 5.1 Stack health

```bash
curl -fsS http://192.168.122.53:9428/health && echo " VL OK"
curl -fsS -H "api-key: $QDRANT_API_KEY" http://192.168.122.53:6333/healthz || \
  docker exec -it onelog-qdrant curl -fsS http://localhost:6333/healthz
docker exec -it onelog-postgres pg_isready -U rag
docker exec -it onelog-redis redis-cli -a "$REDIS_PASSWORD" ping
docker exec -it onelog-nats nats-server --version
```

### 5.2 Ingest path (client → Vector → VictoriaLogs)

Từ **srv-01**:
```bash
logger -t e2e-test "trace-id=abc123 user=alice action=login ok"
```

Trên logserver, query VictoriaLogs sau ~5s:
```bash
curl -fsS 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=e2e-test trace-id=abc123' | jq .
```

Kỳ vọng: 1 record có `host=srv-01`, message chứa `trace-id=abc123`.

Lặp lại từ **srv-02** với token khác (`e2e-test-2`).

### 5.3 Redaction (Vector VRL strip PII)

```bash
logger -t redact-test "user email=alice@example.com ip=10.0.0.5 token=Bearer eyJabc.def.ghi"
sleep 5
curl -fsS 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=redact-test' | jq -r '.[] | .message'
```

Kỳ vọng: KHÔNG có `alice@example.com`, `10.0.0.5`, `eyJabc.def.ghi` — phải bị replace `<EMAIL>`, `<IP>`, `<JWT>`.

### 5.4 Indexer → Qdrant

Bơm 200 log WARN+ giả lập:
```bash
for i in $(seq 1 200); do
  logger -p user.warn -t app-x "Connection reset by peer service=api-$((i%5))"
done
```

Sau ~2 phút, check Qdrant:
```bash
curl -fsS -H "api-key: $QDRANT_API_KEY" \
  "http://192.168.122.53:6333/collections/log_templates" | jq '.result.points_count'
```

Kỳ vọng `points_count > 0` (Drain3 phải gom thành ≤5 template).

### 5.5 RAG Agent end-to-end

```bash
curl -fsS -k -X POST https://192.168.122.53/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Có lỗi connection reset không? Service nào ảnh hưởng?"}' | jq .
```

Kỳ vọng:
- HTTP 200, response < 15s
- `answer` đề cập tới `Connection reset` và liệt kê `service=api-*`
- `sources[]` chứa template_id + link tới VictoriaLogs

### 5.6 Web UI

Mở browser: `https://192.168.122.53/` (chấp nhận cảnh báo TLS self-signed lab).
- Trang chat hiện input box → gõ câu hỏi như 5.5 → thấy stream trả lời + trace panel.
- Trang `/admin` xem indexer lag, embedding cost, drain3 unmatched%.

### 5.7 Alert (Phase 06 — chỉ nếu đã cook)

Trigger 1 alert giả:
```bash
docker exec onelog-alertmanager amtool alert add TestAlert \
  severity=critical service=api-1 --annotation="summary=Smoke alert"
```
Kiểm tra Telegram chat (nếu đã set token).

---

## 6. Verification checklist

- [ ] 3 VM ping được nhau, NTP sync OK
- [ ] `docker compose ps` trên logserver: 10/10 service healthy
- [ ] `logger` từ srv-01 + srv-02 → xuất hiện trong VictoriaLogs trong < 10s
- [ ] PII test: 0 leak trong VL query
- [ ] Qdrant `log_templates.points_count` tăng sau load test
- [ ] RAG `/api/chat` trả về kèm sources
- [ ] Web UI mở được, chat round-trip OK
- [ ] Reboot logserver → stack tự up qua `systemctl status ragstack`
- [ ] `bash infra/scripts/healthcheck.sh` → 0 failure
- [ ] `bash infra/scripts/snapshot-daily.sh` chạy không lỗi, file `onelog-YYYYMMDD-HHMM.tar.gz` xuất hiện trong `/opt/onelog/backup`
- [ ] Restore khô (lab): `bash infra/scripts/restore-snapshot.sh <archive>` → stack up lại với data đúng

---

## 7. Troubleshooting nhanh

| Triệu chứng | Check | Fix |
|---|---|---|
| `apt install docker-compose-plugin` lỗi `trying to overwrite /usr/libexec/docker/cli-plugins/docker-compose` | Ubuntu 24.04 ship sẵn `docker-compose-v2` từ universe repo, conflict path với Docker official | Chạy lại `setup-log-server.sh` (idempotent) — auto purge `docker-compose-v2` `docker.io` trước khi cài Docker CE |
| Docker daemon fail start, log: `metadata.db: no such file or directory` | Sót state cũ từ docker.io khi transition sang docker-ce | `sudo RESET_DOCKER=1 bash setup-log-server.sh` (nuke `/var/lib/{docker,containerd}` rồi reinstall) |
| `docker compose: permission denied while trying to connect to .../docker.sock` | User không trong group docker | `sudo usermod -aG docker $USER && newgrp docker` (hoặc re-login) |
| Vector restart loop, log `Missing environment variable in config. name = "1"` | VRL `$1` backref bị YAML env-var interpolation nuốt | Đã fix trong `vector.yaml`: bỏ backref, dùng literal replacement |
| `logger` từ client không thấy trong VL, Vector log `Failed deserializing frame: unable to parse input as valid syslog message` | rsyslog default RFC3164 timestamp thiếu năm + tz, Vector strict reject | Dùng `setup-rsyslog-client.sh` (TCP 6514 + template RFC5424) |
| rsyslog config error `parameter 'action.resumeFromLastCheckpoint' not known` | Param ảo, không tồn tại trong rsyslog 8.x | Đã loại khỏi `clients/rsyslog-forward.conf` |
| Browser vào `http://<vm-ip>:9428/select/vmui/` timeout | VL bind `127.0.0.1:9428` (loopback only) | Vào qua Caddy: `http://<vm-ip>/select/vmui/` hoặc `http://<vm-ip>/vmui/` (redirect) |
| vmui load HTML nhưng "Failed to load stream fields - 404" | Caddy không proxy `/select/*` (vmui JS gọi absolute paths) | Đã fix Caddyfile: thêm `handle /select/*` + `/insert/*` + `/health` + `/metrics` |
| healthcheck script báo `disk ?% used` | Default `INFRA_DIR=/opt/onelog/infra` không tồn tại nếu repo ở `~/onelog` | Đã fix: auto-detect INFRA_DIR từ script location |
| `sudo` warn `unable to resolve host srv-XX: Name or service not known` | Hostname không có trong /etc/hosts | Cosmetic, không block. Setup script tự add `127.0.1.1 $(hostname)` vào /etc/hosts |
| `git pull` báo "local changes would be overwritten" | Edit file trực tiếp trên VM | `git stash && git pull && git stash pop` (hoặc `git checkout -- <file>` để discard) |
| Qdrant 401 | env `QDRANT_API_KEY` mismatch giữa indexer và qdrant | đồng bộ `.env`, restart cả 2 |
| Indexer lag > 5 phút (Phase 02) | `docker stats indexer` | tăng batch size hoặc thêm worker; check OpenAI rate limit |
| RAG /api/chat 5xx (Phase 03) | `docker compose logs rag-agent` | thiếu `ANTHROPIC_API_KEY` hoặc Postgres down |
| Web 502 qua Caddy (Phase 04) | `docker compose logs caddy web` | web build fail; rebuild `docker compose build web && up -d web` |
| TLS warning browser | bình thường ở lab (self-signed) | accept exception; production phải có domain + LE |

Log tổng hợp:
```bash
docker compose logs --since=10m | grep -iE 'error|panic|fatal'
```

---

## 8. Rollback / cleanup

```bash
# Dừng stack giữ data
docker compose down

# Xóa toàn bộ data (CẨN THẬN)
docker compose down -v
sudo rm -rf /opt/onelog/infra/{victorialogs,qdrant,postgres,redis}

# Khôi phục từ snapshot
bash /opt/onelog/infra/scripts/restore-snapshot.sh /opt/onelog/backup/onelog-YYYYMMDD-HHMM.tar.gz
```

Trên client:
```bash
sudo rm /etc/rsyslog.d/90-forward-onelog.conf && sudo systemctl restart rsyslog
# hoặc
sudo systemctl disable --now vector
```

---

## 9. Lab → Production checklist (sau khi smoke test pass)

- [ ] Thay `tls internal` bằng domain thật + Let's Encrypt
- [ ] Bật auth (email/pass hoặc OIDC) — gỡ IP whitelist
- [ ] Syslog TCP 6514 + client TLS cert thay UDP 514
- [ ] Snapshot offsite (MinIO/S3) thay vì local `/backup`
- [ ] Monitoring: Prometheus scrape `/metrics` của vector + indexer + rag-agent
- [ ] Phase 07 HA roadmap review

---

## 10. Unresolved questions

1. Lab có sẵn DNS resolver nội bộ không? Nếu có, set `APP_DOMAIN=onelog.lab` đẹp hơn IP raw.
2. Client (51, 52) có log volume bao nhiêu để chọn rsyslog vs Vector agent?
3. Có MinIO/NAS trong subnet để snapshot offsite không, hay accept local-only?
4. OpenAI/Anthropic egress: lab có proxy hay direct internet?
