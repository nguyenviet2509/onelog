---
name: observability-integration
status: blocked
created: 2026-06-24
updated: 2026-06-24
owner: trihd@inet.vn
blockedBy: [plans/260623-2041-mcp-only-rollout]
blocks: []
relatedReports:
  - plans/reports/brainstorm-260624-1343-observability-integration.md
relatedPlans:
  - plans/260623-2041-mcp-only-rollout
---

# Plan: Observability integration vào team Prom/Grafana

## Mục tiêu
Tích hợp logserver services (mcp-semantic, mcp-vl, VictoriaLogs, Qdrant, Caddy) vào **team Prometheus + Grafana + Alertmanager hiện hữu**. Không deploy thêm observability stack trên logserver. Giải quyết pain dominant: 5 ops không có dashboard/alert khi container chết hoặc VL ngừng ingest.

## Context
- Brainstorm decision: [brainstorm-260624-1343-observability-integration](../reports/brainstorm-260624-1343-observability-integration.md)
- Trigger: sau khi Phase 02 mcp-only-rollout kill web UI, user hỏi monitor + troubleshoot
- Approach E chosen (1.5-2 ngày) so với standalone stack (3-4 ngày) hoặc custom UI (1-2 tuần)
- Audience: 5 ops nội bộ, dùng MCP qua Claude Desktop

## Phases

| # | Phase | Status | File |
|---|---|---|---|
| 01 | Expose `/metrics` endpoints + Caddy auth route | pending | [phase-01-expose-metrics-endpoints.md](phase-01-expose-metrics-endpoints.md) |
| 02 | Team-side scrape config + Grafana dashboards + alerts | pending | [phase-02-team-grafana-dashboards.md](phase-02-team-grafana-dashboards.md) |
| 03 | Extend `gen-mcp-tokens.sh` CLI (independent, bonus) | pending | [phase-03-extend-token-cli.md](phase-03-extend-token-cli.md) |

## Key dependencies
- **Phase 02 mcp-only-rollout DONE + soak xong** (blocker): cần state production-stable trước khi gắn dashboard, tránh false positive alert
- Team Prom IP/range reachable đến logserver LAN/VPN (netops xác nhận)
- Team Grafana cho phép dev import dashboard JSON (hoặc qua admin)
- `gen-mcp-tokens.sh` đã tồn tại từ Phase 01 mcp-only-rollout

## Success criteria (toàn plan)
- [ ] Team Prom scrape thành công 5 endpoint (`up{job=~"onelog.*"} == 1`)
- [ ] Grafana hiển thị real-time data lag ≤30s
- [ ] Alert test: `docker stop mcp-semantic` → cảnh báo Slack/email ≤2 phút
- [ ] 5 ops biết URL Grafana dashboard
- [ ] CLI `gen-mcp-tokens.sh add/list/revoke` work end-to-end

## Risks (top)
- Network: team Prom IP không có route đến logserver → firewall blocker, escalate netops sớm
- VL/Qdrant metrics naming giả định (`vl_rows_inserted_total`) — verify thực tế khi expose
- mcp-vl upstream có thể không expose `/metrics` native → fallback blackbox synth probe (loss granularity)
- Audit metric cardinality cao nếu label `user × event` không giới hạn → Prom storage bloat

## Out of scope
- Custom admin UI (defer phase-03 review checkpoint của mcp-only-rollout)
- Multi-tenancy/RBAC Grafana
- HTTPS migration cho `/metrics/*` (LAN/VPN plain HTTP OK ở stage này)
- Log-based alerts (VL Alerting feature)
