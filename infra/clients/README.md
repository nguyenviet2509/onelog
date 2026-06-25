# OneLog client forwarders

Drop-in configs for shipping logs from client servers to the OneLog Vector
ingestion endpoint. Pick **one** path based on what the client already runs.

## Option A — RFC5424 syslog (default, simplest)

| File | `rsyslog-forward.conf` |
|---|---|
| Server port | TCP **6514** (RFC5424) — UDP 514 also accepted for legacy |
| Format | Syslog text per RFC5424, ISO timestamp |
| Best for | Greenfield clients, no existing rsyslog pipeline |

Install:
```bash
sudo cp rsyslog-forward.conf /etc/rsyslog.d/90-forward-onelog.conf
sudo sed -i 's/LOG_SERVER_IP/<onelog-host>/' /etc/rsyslog.d/90-forward-onelog.conf
sudo rsyslogd -N1                       # config check
sudo systemctl restart rsyslog
ss -tnp | grep ':6514'                  # must show ESTAB
```

## Option B — JSON ECS-lite (for clients with existing JSON pipelines)

| File | `rsyslog-forward-json.conf` |
|---|---|
| Server port | TCP **6515** |
| Format | JSON line-delimited, schema = ECS-lite |
| Best for | Client already forwarding JSON to ELK/SIEM, OneLog as additional sink |
| rsyslog | ≥ 8.x required (modern omfwd) |

Schema contract (required):
- `@timestamp` — RFC3339 string
- `host.name` — string
- `log.level` — info/warn/error/...
- `service.name` — string
- `message` — string

Optional pass-through: `labels.*`, `trace.id`. **Unknown top-level fields are
dropped** by server-side normalize (anti schema-drift).

Install:
```bash
sudo cp rsyslog-forward-json.conf /etc/rsyslog.d/91-forward-onelog-json.conf
sudo sed -i 's/LOG_SERVER_IP/<onelog-host>/' /etc/rsyslog.d/91-forward-onelog-json.conf
sudo rsyslogd -N1
sudo systemctl restart rsyslog
ss -tnp | grep ':6515'
```

## Network / security

PoC stage = **plain TCP, no auth**. Network protection is mandatory:
- Firewall **inbound TCP 6514/6515** to whitelist client IPs only on logserver
- VPN / private network preferred
- TLS + token auth = separate plan (see roadmap)

## Mock / dev

`mock-logs.py` + `mock-logs.service` generate synthetic syslog (UDP 514) for
local stack smoke tests. Not for production clients.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ss` shows no ESTAB | Firewall blocking, or `target=` IP wrong |
| `rsyslogd -N1` complains about `jsonf` | rsyslog too old (< 8.x) — use Option A |
| Events arrive but `_msg` empty | Client `msg` property has unescaped quotes — check JSON validity in template |
| Schema field missing in VL | Field name typo — re-read schema contract above |
