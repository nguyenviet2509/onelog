# Mock Logs Setup — srv-01 + srv-02

## Context
- Plan: [260622-1056-rag-logserver-victorialogs](../260622-1056-rag-logserver-victorialogs/plan.md)
- Predecessor: [mock-log-client-pipeline](brainstorm-260623-1057-mock-log-client-pipeline.md)
- Targets: srv-01 = 192.168.122.52, srv-02 = 192.168.122.51 (user có sudo, SSH access)
- Current infra: rsyslog forward TCP 6514 plain via `omfwd` template RFC5424 (`infra/clients/rsyslog-forward.conf`). Chưa có imfile config.

## Decision
**B-simplified**: dùng `logger` CLI thay vì flog + imfile. Lý do KISS — tận dụng rsyslog forward sẵn có, không thêm config imfile cho mục đích mock.

## Config chốt
- Rate: **10 ev/s/client** (verify trước, scale lên 50 sau khi pipeline xác nhận ổn)
- PII injection: **5%** (mix email, JWT, AWS key giả, RFC1918)
- App-name tag: `mock-nginx`, `mock-mysql`, `mock-sshd`, `mock-audit`
- Service weight: nginx 60% / mysql 20% / sshd 15% / audit 5%
- Severity weight: info 70% / warn 20% / err 10% (đảm bảo NATS `logs.warn` có flow)
- Deploy: user sudo, SCP files + run setup script

## Deliverables
- `infra/clients/mock-logs.py` — Python generator (4 service line formats, PII inject, logger fork)
- `infra/clients/mock-logs.service` — systemd unit (env vars: MOCK_RATE, MOCK_PII_RATE, MOCK_DURATION)
- `infra/scripts/setup-mock-logs.sh` — install + enable trên client
- `infra/clients/README-mock-logs.md` — usage + verify steps (optional, có thể merge vào script comments)

## Deploy flow
```
local:
  scp infra/clients/mock-logs.py user@srv-01:/tmp/
  scp infra/clients/mock-logs.service user@srv-01:/tmp/
  scp infra/scripts/setup-mock-logs.sh user@srv-01:/tmp/
  ssh user@srv-01 'sudo bash /tmp/setup-mock-logs.sh'
  # repeat for srv-02
```

Setup script tasks:
1. `install -m 0755 /tmp/mock-logs.py /usr/local/bin/mock-logs.py`
2. `install -m 0644 /tmp/mock-logs.service /etc/systemd/system/mock-logs.service`
3. `systemctl daemon-reload && systemctl enable --now mock-logs`
4. `systemctl status mock-logs --no-pager`

## Verify
- Client: `systemctl status mock-logs` → active running, `journalctl -u mock-logs -n 5` → không error
- Logserver VL query: `app_name:~"mock-.*"` → thấy log từ cả 2 host srv-01 + srv-02, đủ 4 service
- Redact audit: query 100 sample → assert 0 email/JWT/AWS leak (test PII redact zero-leak)
- Vector metrics: 0 drop, buffer healthy
- NATS subscribe `logs.warn` (sau khi NATS service lên): đếm ~3 ev/s (30% × 10 ev/s × 2 client = 6 ev/s, mix theo severity)

## Scale-up plan
- Sau 30 phút verify ổn: edit `/etc/systemd/system/mock-logs.service` → MOCK_RATE=50, `systemctl restart mock-logs`
- Burst test optional: MOCK_RATE=500 trong 30s qua override file

## Risks
- `logger` fork mỗi call → giới hạn ~500 ev/s/client. Ở 10-50 ev/s an toàn
- Plain TCP 6514 (chưa TLS) → ack ở phase-01, prod swap
- Mock chiếm bandwidth rsyslog queue → set rate thấp, monitor `ss -tnp | grep 6514`

## Next Steps
1. Implement 3 file (script + unit + setup) — ~30 phút
2. Deploy srv-01, verify VL ingest
3. Deploy srv-02, verify dual-host
4. 30 phút soak → scale MOCK_RATE=50
5. Kick indexer worker D1 (theo [indexer-execution report](brainstorm-260623-1052-indexer-worker-execution.md))

## Unresolved
- SSH user name: chưa biết, sẽ dùng placeholder `<user>` trong doc deploy
- Hostname inside RFC5424 message: rsyslog tự fill `%HOSTNAME%` từ `hostname` command → cần verify srv-01/srv-02 hostname đã set đúng (không phải `localhost`)
