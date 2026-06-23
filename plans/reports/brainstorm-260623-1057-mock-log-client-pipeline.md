# Mock Log at Client → Exercise Full Pipeline

## Context
- Plan: [260622-1056-rag-logserver-victorialogs](../260622-1056-rag-logserver-victorialogs/plan.md)
- Predecessor: [indexer-worker-execution](brainstorm-260623-1052-indexer-worker-execution.md)
- Trigger: 2 client setup xong, log thật chưa volume. Mock log tại client để exercise pipeline + feed indexer test.

## Decision
**Approach B**: flog cho nginx access + Python script cho mysql/sshd/audit, đẩy qua rsyslog TLS đang chạy. Rate base 50 ev/s/client. Vài giờ verify pipeline ổn trước khi vào indexer.

## Rationale
- Exercise toàn bộ chain thật: rsyslog imfile → TLS 6514 → Vector source → parse_app_logs VRL → redact VRL → VL + NATS
- Verify Phase 02 success criteria end-to-end: redact zero leak, NATS severity filter, VL ingest schema
- Feed indexer worker (D1-D4) bằng NATS real data thay synthetic Python fixture → integration test mạnh hơn
- KISS: không build traffic simulator, dùng tool có sẵn (flog) + 50-line script

## Scope

### Mock generators (per client, ~1 ngày)
- [ ] Install `flog` (Go binary)
- [ ] systemd unit `mock-nginx-access.service`: `flog -f apache_combined -d 20ms -o /var/log/nginx/access.log -t log` (50 ev/s, rotate handled by logrotate)
- [ ] `mock-logs.py` — generate mỗi 100-500ms:
  - mysql error (mix INFO/WARN/ERROR, inject 5% PII: email user, IP backend)
  - sshd auth fail (`Failed password for user from 10.x.x.x` — RFC1918 + username)
  - audit kv (`type=USER_LOGIN msg=audit(...): pid=... uid=... acct="..."`)
  - app stack trace (multiline, force ERROR severity)
- [ ] systemd timer `mock-logs.timer` chạy script
- [ ] logrotate config cho mock files (size 100M, keep 3)
- [ ] PII injection: 5% email, 5% JWT, 5% AWS key giả, 10% RFC1918 → verify redact

### Burst test (optional)
- [ ] Script `mock-burst.sh`: 5k ev/s × 30s → đo Vector buffer + NATS backpressure

### Verify pipeline (vài giờ sau khi mock chạy)
- [ ] VL query: 2 client × 4 service (nginx/mysql/sshd/audit) đủ message
- [ ] PII audit: random 100 sample VL → grep email/IP/JWT → assert 0
- [ ] NATS `logs.warn`: subscribe đếm message/s, severity filter đúng
- [ ] Vector metrics: 0 drop, buffer healthy
- [ ] Schema check: VL document có đủ field service/host/severity/ts để Phase 03 query

## Flow
```
Step 1 (1 day):  Mock setup 2 clients → pipeline verify
Step 2 (3-4d):   Indexer worker D1-D4 (NATS real data)
Step 3 (~D3):    Phase 03 scaffold kick song song
Step 4:          Khi log thật về → tắt mock, integration test thật
```

## Success Criteria
- 2 client emit ~50 ev/s steady, không gap
- VL có 4 service mỗi client, lag < 5s
- Redact audit 1000 sample = 0 PII leak
- NATS severity filter chính xác (chỉ WARN+ vào subject)
- Burst 5k ev/s 30s: Vector buffer < 1GB, không drop

## Risks
- **Disk fill client**: logrotate + cap file size. Mock 50 ev/s ~500MB/ngày/client OK
- **Mock format drift với log thật**: tag `appname=mock-*` để filter, swap dễ
- **flog không có VRF realistic enough** cho nginx 5xx burst → bù bằng custom Python emit nginx error
- **PII injection vô tình leak ra Qdrant nếu redact fail**: đó chính là test, expected behavior là 0 leak

## Next Steps
1. Implement mock generators trên 2 client (1 ngày)
2. Verify pipeline (vài giờ)
3. Kick indexer worker D1 theo [predecessor report](brainstorm-260623-1052-indexer-worker-execution.md)

## Unresolved
- 2 client lab thuộc team đã có sudo + flog install được? Hay phải approve qua infra?
- logrotate config có template chung trong Ansible chưa hay tạo mới?
- Mock kéo dài bao lâu trước khi switch log thật — phụ thuộc khi nào 2 client có traffic thật
