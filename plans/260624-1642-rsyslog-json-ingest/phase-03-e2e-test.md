# Phase 03 — E2E test rsyslog container

**Status:** pending
**Priority:** medium
**Effort:** ~3h
**Owner:** vietnt
**Depends on:** Phase 01, Phase 02

## Mục tiêu
Verify end-to-end: rsyslog container giả lập client → OneLog Vector 6515 → PII
redact → VictoriaLogs → query trả đủ events với schema flat đúng.

## Files
- **Create:** `tests/rsyslog-e2e/docker-compose.test.yml`
- **Create:** `tests/rsyslog-e2e/rsyslog.conf` (drop-in client config với `<ONELOG_HOST>` = host network)
- **Create:** `tests/rsyslog-e2e/generate-events.sh` — sinh 1000 events qua `logger`
- **Create:** `tests/rsyslog-e2e/verify.sh` — query VL + assert count + assert PII redacted

## Implementation

### 1. Docker compose test
File `tests/rsyslog-e2e/docker-compose.test.yml`:
```yaml
services:
  rsyslog-client:
    image: rsyslog/syslog_appliance_alpine:latest
    volumes:
      - ./rsyslog.conf:/etc/rsyslog.d/50-onelog.conf:ro
    network_mode: host   # để dễ trỏ về Vector localhost:6515
    command: ["rsyslogd", "-n", "-f", "/etc/rsyslog.conf"]
```

### 2. Client config
`tests/rsyslog-e2e/rsyslog.conf` = copy `infra/clients/rsyslog-forward-json.conf`,
thay `<ONELOG_HOST>` = `127.0.0.1`.

### 3. Generate events
File `tests/rsyslog-e2e/generate-events.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
# 999 normal events
for i in $(seq 1 999); do
  logger -t "demo-svc" -p user.info "test event $i normal payload"
done
# 1 PII event (email + private IP)
logger -t "demo-svc" -p user.warn "user admin@example.com login from 192.168.1.50"
echo "Sent 1000 events"
```

### 4. Verify script
`tests/rsyslog-e2e/verify.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
sleep 5   # vector flush

# Count
count=$(curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=service:demo-svc' | wc -l)
echo "Got $count events (expect >= 1000)"
[ "$count" -ge 1000 ] || { echo "FAIL count"; exit 1; }

# Verify PII redacted: email must not appear
leaked=$(curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=service:demo-svc AND _msg:"admin@example.com"' | wc -l)
[ "$leaked" -eq 0 ] || { echo "FAIL PII leaked"; exit 1; }

# Verify <EMAIL> marker present
masked=$(curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=service:demo-svc AND _msg:"<EMAIL>"' | wc -l)
[ "$masked" -ge 1 ] || { echo "FAIL email mask missing"; exit 1; }

echo "OK all assertions passed"
```

## Todo
- [x] Tạo `tests/rsyslog-e2e/` directory + files (Dockerfile, rsyslog.conf, compose, generate, verify, README)
- [x] Chạy `docker compose -f tests/rsyslog-e2e/docker-compose.test.yml up -d --build`
- [x] Chạy `bash tests/rsyslog-e2e/generate-events.sh` (1000 events sent)
- [x] Chạy `bash tests/rsyslog-e2e/verify.sh` — all assertions PASS
- [ ] Verify NATS branch via `nats sub` — deferred (nats CLI chưa cài trên logserver)
- [ ] Cleanup compose down — deferred (container vẫn dùng cho P4 polish backlog)

## Success criteria
- `verify.sh` exit 0.
- ≥1000 events trong VL với schema flat đúng (`service=demo-svc`, `_msg` populated).
- Email `admin@example.com` không xuất hiện raw trong VL, chỉ thấy `<EMAIL>`.
- 1 event WARN xuất hiện trong NATS subject `logs.warn`.

## Risks
- `network_mode: host` chỉ work trên Linux. Trên Windows/macOS dev → đổi sang
  bridge + map 6515 ra ngoài, point client tới `host.docker.internal:6515`.
- Rsyslog Alpine image có thể không có `omfwd` module mặc định — verify với
  `rsyslogd -v` trước; nếu thiếu, đổi sang image full như `linuxserver/rsyslog`.
- VL query DSL có thể đếm khác cách (lines vs events) — adjust `wc -l` nếu cần.

## Definition of Done
- Tất cả assertion verify.sh pass.
- Test script chạy lặp lại được, không cần manual cleanup ngoài compose down.
- Document cách chạy test trong `tests/rsyslog-e2e/README.md` (1 đoạn ngắn).
