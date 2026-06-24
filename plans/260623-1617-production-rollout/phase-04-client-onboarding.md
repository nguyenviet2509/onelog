# Phase 04 — Client Onboarding

## Context
- [plan.md](plan.md) | [Brainstorm §Stage 4](../reports/brainstorm-260623-1617-production-rollout.md)

## Overview
- Priority: P1
- Status: pending
- Effort: 2-3 ngày (+ 24h pilot)
- Mục tiêu: Script idempotent cài rsyslog forward TLS lên 5 prod server. Pilot 1 server 24h → roll 4 server còn lại.

## Requirements
- Ubuntu/Debian + SSH key access (đã có)
- TLS cert client (CA cert từ corp CA - Phase 00)
- rsyslog forward 6514 TCP TLS đến `logserver.corp.local`
- Hostname + service tag chuẩn hoá
- Healthcheck verify VL nhận log trong 30s

## Related files
- `infra/scripts/install-onelog-client.sh` — **create** (replace `mock-logs.py` setup)
- `infra/scripts/uninstall-onelog-client.sh` — **create**
- `infra/clients/rsyslog-99-onelog.conf` — **create** (template forward config)
- `infra/clients/onelog-ca.crt` — **create symlink** từ Phase 01 CA
- `infra/scripts/onboard-server.sh` — **create** (wrapper SSH → install)

## Implementation steps
1. Write `rsyslog-99-onelog.conf`:
   ```
   *.* action(type="omfwd"
              target="logserver.corp.local" port="6514" protocol="tcp"
              StreamDriver="gtls" StreamDriverMode="1"
              StreamDriverAuthMode="x509/name"
              StreamDriverPermittedPeers="logserver.corp.local")
   ```
2. Write `install-onelog-client.sh` idempotent:
   - Check rsyslog version ≥ 8 (Ubuntu 22.04 default 8.2)
   - `apt install -y rsyslog-gnutls`
   - Copy CA cert → `/etc/ssl/onelog-ca.crt`
   - Copy config → `/etc/rsyslog.d/99-onelog.conf` (substitute hostname)
   - `systemctl restart rsyslog`
   - Send healthcheck: `logger -t onelog-install "healthcheck $HOSTNAME $(date +%s)"`
   - Wait 30s → query VL: `curl logserver.corp.local/select/logsql/query?query=service:onelog-install` → expect 1 hit
   - Exit 0 nếu pass, 1 nếu fail
3. Write `onboard-server.sh`:
   - Args: server IP
   - SSH với key, scp install script + CA cert + config
   - Run install script remotely
   - Report status
4. **Pilot**: Run `onboard-server.sh` trên 1 prod server (chọn ít traffic nhất)
5. Verify 24h: volume thực, error rate, PII leak post-ingest 0
6. Adjust nếu cần (regex, retention)
7. Roll 4 server còn lại tuần tự 1/ngày
8. Mock log generator trên srv-01/02 → **disable** sau khi 2 server prod thật ingest ổn (giữ srv-01/02 làm dev test)
9. Document client list: `docs/onboarded-servers.md`

## Todo
- [ ] rsyslog config template + CA cert
- [ ] install-onelog-client.sh idempotent + tested local
- [ ] onboard-server.sh wrapper
- [ ] Pilot server 1 onboarded + 24h verify
- [ ] Volume + redaction adjusted per pilot data
- [ ] 4 server còn lại onboarded
- [ ] Mock generator disabled trên srv-01/02
- [ ] docs/onboarded-servers.md committed

## Success criteria
- 5/5 server gửi log thành công, healthcheck pass
- Tổng volume 5-20 GB/ngày (match estimate)
- PII audit 0 leak (Phase 03 patterns work)
- Indexer lag < 1 phút sustained

## Risks
- rsyslog version cũ trên server cũ → manual upgrade hoặc skip server đó
- TLS handshake fail → debug bằng `openssl s_client`, fix cert chain
- Volume vượt estimate (40+ GB/ngày) → scale VM (Phase 06 doc) hoặc thắt retention 3 ngày

## Security
- CA cert phân phối qua secure channel (scp với SSH key, không Telegram/email)
- Mỗi server tag `host=$HOSTNAME` để truy vết source
- Nếu server compromise → revoke CA cert, regenerate

## Next steps
Sau khi 5 server ingest ổn → Phase 07 soak start
