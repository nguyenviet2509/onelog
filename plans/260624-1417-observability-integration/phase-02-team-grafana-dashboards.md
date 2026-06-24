# Phase 02 — Team Prom scrape + Grafana dashboards + Alertmanager rules

## Context
- Plan: [plan.md](plan.md)
- Depends on: Phase 01 endpoints reachable
- Audience: ops team (thao tác trên team Prom/Grafana, KHÔNG sửa code logserver)

## Overview
- Priority: P1
- Status: pending
- Effort: ~0.5 ngày-người (chủ yếu ops paste config)
- Mục tiêu: team Prom scrape 5 endpoint, Grafana hiển thị 5 dashboard, Alertmanager bắn 4 alert rule.

## Key insights
- Phase này 90% operational: paste YAML vào team Prom + import JSON vào team Grafana. Logserver chỉ host doc + dashboard JSON exports.
- Pre-built dashboards công khai trên grafana.com — không reinvent
- Slack/email channel Alertmanager team đã có sẵn → reuse, chỉ add 4 rule

## Architecture
```
Team Prom ──scrape──► Caddy /metrics/<service>
   │
   ├─► Team Alertmanager ──► Slack/email
   └─► Team Grafana ──► 5 dashboards
```

## Related files

**Create:**
- `docs/observability-integration.md` — handover doc: endpoint URLs, basic auth creds (placeholder ref `.env`), dashboard URLs, ops runbook
- `infra/observability/prometheus-scrape.yml` — snippet để paste vào team `prometheus.yml`
- `infra/observability/alert-rules.yml` — 4 alert rule YAML để paste vào team Alertmanager
- `infra/observability/dashboards/onelog-overview.json` — custom dashboard
- `infra/observability/dashboards/mcp-audit.json` — custom dashboard
- `infra/observability/dashboards/README.md` — list dashboards với grafana.com ID hoặc local JSON path

## Implementation steps

### Step 1 — Prometheus scrape config (0.1d)
Tạo `infra/observability/prometheus-scrape.yml`:
```yaml
scrape_configs:
  - job_name: onelog-mcp-semantic
    metrics_path: /metrics/mcp-semantic
    scheme: http
    basic_auth: { username: prom, password_file: /etc/prom/onelog-pwd }
    static_configs: [{ targets: ['logserver-01.lan:80'] }]
  - job_name: onelog-victorialogs
    metrics_path: /metrics/victorialogs
    basic_auth: { username: prom, password_file: /etc/prom/onelog-pwd }
    static_configs: [{ targets: ['logserver-01.lan:80'] }]
  - job_name: onelog-qdrant
    metrics_path: /metrics/qdrant
    basic_auth: { username: prom, password_file: /etc/prom/onelog-pwd }
    static_configs: [{ targets: ['logserver-01.lan:80'] }]
  - job_name: onelog-caddy
    metrics_path: /metrics/caddy
    basic_auth: { username: prom, password_file: /etc/prom/onelog-pwd }
    static_configs: [{ targets: ['logserver-01.lan:80'] }]
  # mcp-vl: native nếu Phase 01 confirmed, else dùng blackbox probe
  - job_name: onelog-mcp-vl
    metrics_path: /metrics/mcp-vl
    basic_auth: { username: prom, password_file: /etc/prom/onelog-pwd }
    static_configs: [{ targets: ['logserver-01.lan:80'] }]
```

### Step 2 — Grafana dashboards (0.2d)
5 dashboards, import qua team Grafana UI (Dashboards → Import):

| # | Dashboard | Source | Notes |
|---|---|---|---|
| 1 | Onelog Overview | local JSON `infra/observability/dashboards/onelog-overview.json` | services up/down, MCP req rate, VL ingest rate. Build từ scratch ~30 phút |
| 2 | Container Health | grafana.com ID `1860` (Node Exporter Full) hoặc `893` (Docker container) | filter host=logserver-01 |
| 3 | VictoriaLogs | grafana.com ID `17050` (verify ID hiện hành tại grafana.com/grafana/dashboards/?search=victorialogs) | pre-built |
| 4 | Qdrant | grafana.com search "qdrant" — ID phổ biến `18271` (verify) | pre-built |
| 5 | MCP Audit | local JSON `infra/observability/dashboards/mcp-audit.json` | custom: `mcp_request_total` by user/tool/status, deny spike |

Build custom JSON onelog-overview gồm panel:
- Stat `up{job=~"onelog.*"}` (5 stat 1 row)
- Graph `rate(mcp_request_total[5m])` by user
- Graph `rate(vl_rows_inserted_total[5m])` (verify metric name)
- Graph `rate(caddy_http_requests_total[5m])` by route

### Step 3 — Alert rules (0.1d)
Tạo `infra/observability/alert-rules.yml`:
```yaml
groups:
  - name: onelog
    interval: 30s
    rules:
      - alert: OnelogServiceDown
        expr: up{job=~"onelog.*"} == 0
        for: 2m
        labels: { severity: critical, team: onelog }
        annotations:
          summary: "Onelog service {{ $labels.job }} down"
      - alert: OnelogVLIngestStalled
        expr: rate(vl_rows_inserted_total[5m]) == 0
        for: 5m
        labels: { severity: warning, team: onelog }
        annotations:
          summary: "VictoriaLogs không ingest 5 phút"
      - alert: OnelogMCPDenySpike
        expr: rate(mcp_request_total{status="denied"}[1m]) > 10
        for: 1m
        labels: { severity: warning, team: onelog }
        annotations:
          summary: "MCP deny spike (possible brute force)"
      - alert: OnelogVLDiskHigh
        expr: vl_data_size_bytes / vl_data_max_bytes > 0.8
        for: 10m
        labels: { severity: warning, team: onelog }
        annotations:
          summary: "VictoriaLogs disk usage >80%"
```

### Step 4 — Documentation (0.1d)
Tạo `docs/observability-integration.md` gồm:
- Endpoint URLs (5 endpoint qua Caddy)
- Basic auth credential handover (ref `.env` key `PROM_BASIC_AUTH_PWD`, không paste raw)
- Grafana dashboard URLs (sau khi team import)
- Alert routing (Slack channel, email DL)
- Ops runbook: "Khi alert X fire → check Y"

### Step 5 — Validation
1. Team ops paste scrape config + reload Prom: `curl http://team-prom/api/v1/targets` → 5 target state=up
2. Import 5 dashboard, mở từng cái → có data
3. Alert test: `docker stop onelog-mcp-semantic` từ logserver → Slack alert trong ≤2 phút
4. Restore: `docker start onelog-mcp-semantic` → alert resolve

## Todo
- [ ] Confirm netops: team Prom IP route đến logserver
- [ ] Confirm grafana.com dashboard ID cho VL + Qdrant (search hiện hành)
- [ ] Tạo `prometheus-scrape.yml`
- [ ] Tạo `alert-rules.yml`
- [ ] Build custom JSON onelog-overview
- [ ] Build custom JSON mcp-audit
- [ ] Tạo `docs/observability-integration.md`
- [ ] Handover ops paste config team Prom
- [ ] Import 5 dashboard
- [ ] Add 4 alert rule
- [ ] Smoke alert test (docker stop)

## Success criteria
- Team Prom targets API: 5/5 `up`
- Grafana 5 dashboard render data, lag ≤30s
- Alert `OnelogServiceDown` fire ≤2 phút khi container stop, resolve khi start
- Ops doc commit vào `docs/`

## Risks
- Pre-built dashboard ID có thể đổi/deprecate → fallback build custom panel cơ bản
- VL metric `vl_rows_inserted_total` tên giả định → verify thực tế Phase 01, update alert rule + dashboard nếu khác
- Team Alertmanager routing config khác convention onelog → coordinate channel naming với ops lead

## Security
- Basic auth pwd handover qua secure channel (1Password/vault team), không paste vào Slack/git
- Dashboard không expose creds; chỉ data metric
- Alert annotation không leak query/user PII

## Unresolved questions
- Grafana.com dashboard ID chính xác cho VictoriaLogs v1.x và Qdrant v1.x hiện hành? (cần search lúc triển khai)
- Team Alertmanager có route theo label `team: onelog` sẵn không, hay phải add route mới?
- Node exporter trên logserver host đã chạy chưa (cho dashboard #2)? Nếu chưa, thêm step deploy node_exporter.
