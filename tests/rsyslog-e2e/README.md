# rsyslog → OneLog E2E test

End-to-end smoke test for the JSON-over-TCP ingest path (Vector source
`rsyslog_json_tcp` on port 6515). Spins a real rsyslog container that
forwards via `omfwd` JSON template, then asserts events land in VictoriaLogs
with PII redaction applied.

## Prerequisites

- OneLog stack running: `docker compose -f infra/docker-compose.yml up -d`
- Vector listening on `127.0.0.1:6515` (verify: `ss -tlnp | grep 6515`)
- VictoriaLogs reachable at `http://127.0.0.1:9428`
- Linux host (uses `network_mode: host`). On Docker Desktop see notes below.

## Run

```bash
# Build + start rsyslog client container
docker compose -f tests/rsyslog-e2e/docker-compose.test.yml up -d --build

# Generate 1000 events (999 info + 1 WARN with PII)
bash tests/rsyslog-e2e/generate-events.sh

# Verify VictoriaLogs has all events + PII masked
bash tests/rsyslog-e2e/verify.sh

# Cleanup
docker compose -f tests/rsyslog-e2e/docker-compose.test.yml down
```

## What it checks

- ≥1000 events with `service:demo-svc` in VictoriaLogs.
- Email `admin@example.com` never appears raw → only `<EMAIL>` marker.
- Private IP `192.168.1.50` never appears raw → only `<PRIV_IP>` marker.

## Files

| File | Purpose |
|---|---|
| `Dockerfile.rsyslog-client` | Alpine + rsyslog + logger CLI |
| `rsyslog.conf` | Main rsyslog config: imuxsock + imtcp:5514 + omfwd JSON → 127.0.0.1:6515 |
| `docker-compose.test.yml` | Build + run with `network_mode: host` |
| `generate-events.sh` | `docker exec logger ...` × 1000 |
| `verify.sh` | curl LogsQL queries + asserts |

## Docker Desktop (Windows/macOS) notes

`network_mode: host` doesn't reach host services on Docker Desktop. To run there:
1. Remove `network_mode: host` from `docker-compose.test.yml`.
2. Add `extra_hosts: ["host.docker.internal:host-gateway"]`.
3. Edit `rsyslog.conf` line `target="127.0.0.1"` → `target="host.docker.internal"`.
4. Map test-side TCP if generating from host: `ports: ["5514:5514/tcp"]`.

## Extending

Phase 04 of the plan adds richer scenarios (schema robustness, PII matrix,
severity routing, coexistence, resilience). See
`plans/260624-1642-rsyslog-json-ingest/phase-04-test-scenarios.md`.
