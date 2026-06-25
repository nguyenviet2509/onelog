# Phase 01 — Vector source + normalize transform

**Status:** pending
**Priority:** high
**Effort:** ~3h
**Owner:** vietnt

## Mục tiêu
Thêm Vector `socket` source TCP 6515 (JSON line-delimited) + transform `remap` map
ECS-lite client → flat OneLog fields. Nối vào `redact` chain hiện hữu để hưởng PII
redaction + dual sink VictoriaLogs/NATS.

## Files
- **Modify:** `infra/vector/vector.yaml`
- **Modify:** `docker-compose.yml` (expose port 6515 nếu chưa)

## Implementation

### 1. Thêm source `rsyslog_json_tcp`
Vào block `sources:` của `infra/vector/vector.yaml`:
```yaml
rsyslog_json_tcp:
  type: socket
  mode: tcp
  address: 0.0.0.0:6515
  decoding:
    codec: json
  framing:
    method: newline_delimited
  connection_limit: 1024
```

### 2. Thêm transform `rsyslog_json_normalize`
Trước transform `enrich`, thêm:
```yaml
rsyslog_json_normalize:
  type: remap
  inputs: [rsyslog_json_tcp]
  source: |
    # Map ECS-lite → flat OneLog schema
    ._time = to_timestamp!(.@timestamp ?? .timestamp ?? now())
    .host = string!(.host.name ?? .host ?? "unknown")
    .severity = downcase(string!(.log.level ?? .severity ?? "info"))
    .service = string!(.service.name ?? .service ?? "unknown")
    ._msg = string!(.message ?? .msg ?? "")
    # Whitelist drop để tránh schema drift
    keep_keys = ["_time", "host", "severity", "service", "_msg", "labels", "trace"]
    . = filter(object!(.)) -> |k, _v| { includes(keep_keys, k) }
```

### 3. Sửa `inputs` của transform `redact`
Đổi từ `inputs: [enrich]` → `inputs: [enrich, rsyslog_json_normalize]`.
*Lý do:* JSON source đã có flat fields, không cần đi qua `enrich` (vốn xử lý
syslog parser output như `appname`, `hostname`, `procid`).

### 4. Expose port docker-compose
Trong service `vector`:
```yaml
ports:
  - "514:514/udp"
  - "6514:6514/tcp"
  - "6515:6515/tcp"   # NEW: rsyslog JSON
```

## Reload test
```bash
docker compose restart vector
docker logs vector --tail 50 | grep -i "started\|error"
# Verify listener
docker exec vector ss -tlnp | grep 6515
# Manual JSON inject
echo '{"@timestamp":"2026-06-24T16:50:00Z","host":{"name":"test-1"},"log":{"level":"warn"},"service":{"name":"demo"},"message":"hello onelog"}' | nc -q1 localhost 6515
# Query VL
curl 'http://localhost:9428/select/logsql/query' --data-urlencode 'query=service:demo' | head
```

## Todo
- [x] Thêm source `rsyslog_json_tcp` vào vector.yaml
- [x] Thêm transform `rsyslog_json_normalize`
- [x] Sửa `redact.inputs` thêm normalize
- [x] Expose port 6515 trong docker-compose
- [x] Reload vector + verify listener (0.0.0.0:6515 LISTEN confirmed)
- [x] Test inject 1 JSON event → VL query thấy (PII redacted, ECS-lite mapped)

## Hotfixes applied during deploy
- VRL E651: `.foo ?? bar` → `string(.foo) ?? ...` (path access is infallible).
- VRL E105: `to_timestamp()` → `parse_timestamp(value, format: "%+")`
  (Vector 0.40 build does not accept string in `to_timestamp`).
- VRL E651 #2: removed trailing `?? "info"` after `downcase(level)` (level is
  typed string after `string()` chain → downcase infallible).

## Success criteria
- `docker logs vector` không có error sau reload.
- `ss -tlnp` show 6515 listening.
- 1 JSON event inject qua `nc` → VL query trả về với 5 field flat populated đúng.

## Risks
- VRL syntax `keep_keys` filter — có thể cần test riêng cú pháp `filter()`.
  Backup: dùng `del(...)` từng key không-whitelist (verbose hơn nhưng chắc).
- `redact` transform giả định `._msg` là string — JSON normalize phải đảm bảo
  `_msg` luôn string (đã có `string!(.message ?? ...)`).
