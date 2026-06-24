# Brainstorm — Observability integration vào team Prom/Grafana

## Context
- Date: 2026-06-24 13:43+07:00
- Trigger: Phase 02 vừa kill web UI, user hỏi dashboard cho token + monitor + troubleshoot
- Pre-condition: Team đã có Prometheus + Grafana + Alertmanager central. Logserver chưa tích hợp.
- Branch: `feat/phase02-onboarding` (merged → master ở `577d26e`)

## Problem statement
5 ops dùng MCP qua Claude Desktop. Khi container chết / VL ngừng ingest / Qdrant treo → không có cảnh báo, không có dashboard. Hiện chỉ có `docker ps` + VMUI + JSON audit. Pain dominant = **observability**, không phải token mgmt (5 ops × 1 token/quý = CLI ổn).

## Decision
Tích hợp logserver services vào team Prom/Grafana hiện hữu (không deploy thêm observability stack trên logserver).

## Approaches considered

| Option | Effort | Verdict |
|--------|--------|---------|
| A. Standalone Prom+Grafana trên logserver | 3-4 ngày | ❌ duplicate team infra |
| B. Custom admin dashboard (Next.js) | 1-2 tuần | ❌ vi phạm YAGNI cho 5 ops, lặp sai lầm vừa fix |
| C. Hybrid (Grafana + tiny token UI) | 1 tuần | ❌ 2 systems maintain |
| D. Defer, document CLI workflow | 0 ngày | ⚠️ ignore pain hiện hữu |
| **E. Integration với team Prom/Grafana** | **1-1.5 ngày** | ✅ **chosen** |

## Final design

### Components
- `/metrics` endpoints expose từ logserver services
- Caddy route `/metrics/<service>` + IP allowlist + basic auth fallback
- Team Prometheus scrape các endpoint qua LAN/VPN
- Grafana dashboards import vào instance team
- Alert rules thêm vào team Alertmanager (reuse Slack/email existing)

### Endpoints exposed
| Service | Source | Action |
|---------|--------|--------|
| `victorialogs:9428/metrics` | built-in | route through Caddy |
| `qdrant:6333/metrics` | built-in | route through Caddy |
| `caddy:2019/metrics` | built-in | route through Caddy |
| `mcp-vl:8000/metrics` | verify upstream | nếu không có → blackbox synth probe |
| `mcp-semantic:9000/metrics` | **NEW code** | thêm `prometheus_client` + counter `mcp_request_total{user, event, status}` |

### Dashboards (5 panel, import JSON sẵn có)
1. **Onelog Overview** — services up/down (auto từ `up` metric), MCP request rate, VL ingest rate
2. **Container Health** — node-exporter (đã có sẵn trên logserver?) + docker_container_metrics
3. **VictoriaLogs** — ingest rate, disk usage, query latency, error rate (pre-built ID 17050 trên grafana.com)
4. **MCP Audit** — request count by user/tool/status, deny spike detection (custom)
5. **Synth Uptime** — endpoint probe results (qua blackbox của team)

### Alert rules (4 cái, thêm vào team Alertmanager)
1. `up{job=~"onelog.*"} == 0 for 2m` → critical
2. `rate(vl_rows_inserted_total[5m]) == 0 for 5m` → warning
3. `rate(mcp_request_total{status="denied"}[1m]) > 10` → warning (brute force)
4. `vl_data_size_bytes / vl_data_max_bytes > 0.8` → warning

### Auth model
- Caddy route `/metrics/*`:
  - IP allowlist: team Prom IP range
  - Basic auth fallback: user `prom` / random pwd trong `.env` (`PROM_BASIC_AUTH_PWD`)
  - Per-service path để Prom dùng `metrics_path: /metrics/<service>` trong scrape config
- Plain HTTP qua LAN/VPN OK; nếu sau migrate Internet → trigger HTTPS sớm (Phase 04)

### Token mgmt CLI (bonus, có thể độc lập)
Extend `infra/scripts/gen-mcp-tokens.sh`:
- `gen-mcp-tokens.sh add <user>` — append .env, restart mcp-semantic
- `gen-mcp-tokens.sh list` — show mask token
- `gen-mcp-tokens.sh revoke <user>` — remove + restart
- All ops audit log entry

## Effort + timeline

| Task | Time | Owner |
|------|------|-------|
| Add `/metrics` Prom client to mcp-semantic | 0.5d | dev |
| Verify mcp-vl native /metrics | 0.2d | dev |
| Caddy `/metrics/*` route + auth | 0.3d | dev |
| Import 5 Grafana dashboards | 0.3d | ops |
| Add 4 alert rules vào team Alertmanager | 0.2d | ops |
| Extend gen-mcp-tokens.sh | 0.5d | dev |
| Doc `docs/observability-integration.md` | 0.2d | dev |
| **Total** | **~1.5-2d** | |

## Success criteria
- [ ] Team Prom scrape thành công 5 endpoint từ logserver
- [ ] Grafana hiển thị real-time data ≤30s lag
- [ ] Alert test: `docker stop mcp-semantic` → cảnh báo Slack trong 2 phút
- [ ] 5 ops biết URL Grafana dashboard, có thể truy cập
- [ ] CLI token: add/list/revoke work end-to-end

## Risks
- **Network reachability**: Verify team Prom IP có route đến logserver LAN/VPN. Block firewall = blocker.
- **VL metrics naming**: `vl_rows_inserted_total` là giả định, verify real metric name khi exposed.
- **mcp-vl không expose /metrics native**: fallback synth probe via blackbox (loss granularity).
- **Audit metric cardinality**: nếu user/event labels = cao → Prom storage bloat. Limit cardinality khi expose.

## Out of scope (intentional)
- Custom admin UI (Option B/C) — defer Phase 03 nếu retro confirm pain
- Multi-tenancy/RBAC Grafana — 5 ops không cần
- HTTPS migration — Phase 04+
- Log-based alerts (VL Alerting feature) — Phase 04+

## Unresolved questions
- IP/range chính xác của team Prometheus → cần lấy từ netops
- Team Grafana cho phép user dev import dashboard JSON, hay phải qua admin?
- `node_exporter` đã chạy trên logserver host chưa? (cho host-level CPU/mem) — assume có
- Audit log retention 90 ngày dùng logrotate cron hay Vector pipeline → decide trong plan
