# OneLog Ops Cheatsheet — Pull / Restart / Verify

> Quick reference cho ops khi đổi config service. Chạy trên **logserver-01** (`192.168.122.53`).
> Repo path mặc định: `~/onelog/infra`.

## 0. Quy tắc vàng — chọn `reload` hay `force-recreate`

| File đổi | Service | Lệnh đúng | Tại sao |
|---|---|---|---|
| `vmalert/rules.yml` | vmalert | `curl -X POST :8880/-/reload` | vmalert đọc thẳng file bind-mount |
| `alertmanager/alertmanager.yml` | alertmanager | **`up -d --force-recreate`** | entrypoint render sed vào `/tmp/` chỉ tại start → reload không pick file mới |
| `docker-compose.yml` (env, volumes, command) | tuỳ service | **`up -d --force-recreate <svc>`** | reload chỉ áp config file, không áp compose change |
| `vector/vector.yaml` | vector | `docker compose restart vector` | vector reload cần SIGHUP, restart đơn giản hơn |
| Image bump (`image:` tag mới) | tuỳ service | `up -d --pull always <svc>` | kéo image mới |

→ **Khi nghi ngờ, dùng `--force-recreate`** — luôn an toàn, chỉ tốn ~5s downtime.

---

## 1. Lệnh phổ biến (copy-paste)

### Pull mã mới + recreate 1 service

```bash
cd ~/onelog && git pull && \
docker compose -f infra/docker-compose.yml --profile alerts up -d --force-recreate <service>
```

Thay `<service>` bằng `vmalert`, `alertmanager`, `vector`, `victorialogs`, …

### Pull + recreate cả alert stack

```bash
cd ~/onelog && git pull && \
docker compose -f infra/docker-compose.yml --profile alerts up -d --force-recreate vmalert alertmanager
```

### Reload rules vmalert (KHÔNG cần đổi compose)

```bash
cd ~/onelog && git pull && \
curl -X POST http://localhost:8880/-/reload && echo "vmalert reloaded"
```

### Recreate toàn stack (nuclear option)

```bash
cd ~/onelog && git pull && \
docker compose -f infra/docker-compose.yml --profile alerts up -d --force-recreate
```

---

## 2. Per-service quick commands

### vmalert (`:8880`)
```bash
# Reload rules (file đổi only)
curl -X POST http://localhost:8880/-/reload

# Recreate (compose đổi)
docker compose -f infra/docker-compose.yml --profile alerts up -d --force-recreate vmalert

# Status
curl -s http://localhost:8880/api/v1/rules | python3 -m json.tool | head -40
```

### alertmanager (`:9093`)
```bash
# LUÔN recreate (do entrypoint sed)
docker compose -f infra/docker-compose.yml --profile alerts up -d --force-recreate alertmanager

# Active alerts
curl -s http://localhost:9093/api/v2/alerts | python3 -m json.tool

# Tail log
docker logs ragstack-alertmanager --since 2m | grep -iE "error|notify"
```

### vector (`:8686` api, `:514/udp`, `:6514/tcp`)
```bash
docker compose -f infra/docker-compose.yml restart vector

# Metrics
curl -s http://localhost:8686/metrics | grep -E "vector_component_received_events_total"
```

### victorialogs (`:9428`)
```bash
docker compose -f infra/docker-compose.yml restart victorialogs

# Query
curl -s "http://localhost:9428/select/logsql/query" \
  --data-urlencode 'query=_time:5m | stats count() as n'
```

### mcp-vl / mcp-semantic / indexer / rag-agent
```bash
docker compose -f infra/docker-compose.yml up -d --force-recreate <service>
docker logs ragstack-<service> --tail 50
```

---

## 3. Verify sau restart

```bash
# Container status
docker compose -f infra/docker-compose.yml --profile alerts ps

# vmalert rules đã load
curl -s http://localhost:8880/api/v1/rules | python3 -c "
import json,sys
d=json.load(sys.stdin)
for g in d['data']['groups']:
  print(g['name'],'->',len(g['rules']),'rules')
"

# AM config đã apply (so với file bind-mount)
docker exec ragstack-alertmanager md5sum /tmp/alertmanager.yml /etc/alertmanager/alertmanager.yml
# 2 hash khác nhau là OK (token đã render). Quan trọng là /tmp/ vừa được tạo lại.

# AM uptime + timezone
curl -s http://localhost:9093/api/v2/status | python3 -c "
import json,sys
d=json.load(sys.stdin); print('uptime:',d.get('uptime'))"
```

---

## 4. Test fire alert (từ srv-01 → logserver-01)

```bash
# Trigger DiskFullErrors (instant rule, ~30-40s fire)
logger -n 192.168.122.53 -P 514 -d -p user.err -t myapp \
  "write failed: No space left on device test-$(date +%s)"

# Trigger OomKillEvent
logger -n 192.168.122.53 -P 514 -d -p user.crit -t kernel \
  "oom-killer: Killed process 9999 (java) total-vm:8G"

# Trigger SshBruteForce (burst rule, ~5-6m fire)
for i in $(seq 1 25); do
  logger -n 192.168.122.53 -P 514 -d -p auth.info -t mock-sshd \
    "Failed password for root from 203.0.113.99 port 22 ssh2"
  sleep 0.2
done
```

Verify trên logserver:
```bash
# Log đã vào VL
curl -s "http://localhost:9428/select/logsql/query" \
  --data-urlencode 'query=_time:1m _msg:"No space left" | stats by (host) count() as n'

# Alert active
curl -s http://localhost:9093/api/v2/alerts | python3 -c "
import json,sys
for a in json.load(sys.stdin):
  print(a['labels'].get('alertname'),a['status']['state'])
"
```

---

## 5. Rollback nhanh

```bash
cd ~/onelog && git log --oneline -5

# Revert file cụ thể về commit trước
git checkout <prev-sha> -- infra/vmalert/rules.yml infra/alertmanager/alertmanager.yml

# Apply
docker compose -f infra/docker-compose.yml --profile alerts up -d --force-recreate vmalert alertmanager
```

---

## 6. Gotchas đã gặp

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| Alert fire nhưng không có Telegram | Template AM lỗi syntax | `docker logs ragstack-alertmanager` tìm `template:` error |
| Đổi `alertmanager.yml` nhưng AM dùng config cũ | Entrypoint sed render `/tmp/` chỉ tại start | `--force-recreate`, không phải reload |
| Timestamp Telegram là UTC (`+00:00`) | Container thiếu tzdata | Mount `/usr/share/zoneinfo:/usr/share/zoneinfo:ro` + `TZ=Asia/Ho_Chi_Minh` |
| `logger -p kern.*` log vào VL với `facility=user` | Linux remap kernel facility từ user-space syslog | Rule expr đừng filter `facility:kern`, match theo `service:` hoặc msg pattern |
| `lastSamples: 0` dù query thủ công có | Log gửi sau khi vmalert vừa eval xong | Đợi tick eval kế tiếp (instant 30s, burst 5m) |
| `git pull` nhưng file không update | Đang ở branch khác / có local changes staged | `git status` → switch master hoặc stash |
| Log từ srv gửi đến `127.0.0.1` không vào VL | Loopback của srv, không phải logserver | Dùng IP/hostname của logserver (`192.168.122.53`) |

---

## Tham khảo
- [deployment-guide.md](./deployment-guide.md) — setup ban đầu
- [mockups/onelog-services-detail.html](../mockups/onelog-services-detail.html) — chi tiết từng service
- vmalert UI: `http://localhost:8880`
- alertmanager UI: `http://localhost:9093`
- VictoriaLogs UI: `http://localhost:9428/select/vmui/`
