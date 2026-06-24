# Phase 06 — Operational Readiness

## Context
- [plan.md](plan.md) | [Brainstorm §Stage 6](../reports/brainstorm-260623-1617-production-rollout.md)

## Overview
- Priority: P1
- Status: pending
- Effort: 2-3 ngày
- Mục tiêu: Metrics + dashboard + oncall alert infra-level + backup restore drill (gating). Runbook 1 trang.

## Requirements
- VictoriaMetrics scrape `/metrics` từ agent + indexer + web
- Grafana dashboard tối thiểu
- Oncall alert kênh Telegram riêng (không chung alert log)
- Backup restore drill PASS (gating)
- Runbook 1 trang có thật

## Related files
- `infra/docker-compose.yml` — add `victoriametrics` service + grafana
- `infra/victoriametrics/prometheus.yml` — **create** scrape config
- `infra/grafana/provisioning/datasources/vm.yaml` — **create**
- `infra/grafana/dashboards/onelog.json` — **create** (export sau khi build UI)
- `web/src/app/api/metrics/route.ts` — **create** (expose Prometheus format)
- `infra/vmalert/rules-infra.yml` — **create** (infra-level alerts khác log-alerts)
- `infra/alertmanager/alertmanager.yml` — add route oncall vs log-alert
- `infra/scripts/backup-restore-drill.sh` — **create**
- `docs/oncall-runbook.md` — **create** (incident playbook)
- `docs/deployment-guide.md` — update với prod config

## Implementation steps
1. Add `victoriametrics` + `grafana` services (profile `obs`)
2. Scrape config:
   ```yaml
   - job_name: agent
     static_configs: [{targets: ["agent:8080"]}]
     metrics_path: /metrics
   - job_name: indexer
     static_configs: [{targets: ["indexer:9100"]}]
   - job_name: web
     static_configs: [{targets: ["web:3000"]}]
     metrics_path: /api/metrics
   ```
3. Add `/api/metrics` Next.js route exporting Prometheus format (request count, latency p95, audit_log writes/min)
4. Grafana dashboard: 6 panel
   - Ingest rate (events/s) per service
   - Indexer lag (NATS pending - delivered)
   - Qdrant qps + p99 latency
   - Chat p95 latency + error rate
   - LLM token spend per hour + cost
   - Disk usage + audit_log row count
5. `vmalert` infra rules:
   - `disk_usage > 0.8` for 5m
   - `up{job="agent"} == 0` for 1m → "agent down"
   - `indexer_consumed - indexer_upserted > 5000` for 10m → "indexer lag"
   - `container_restart_count > 3` in 10m → restart loop
6. Alertmanager route: label `severity=ops` → Telegram oncall chat; `severity=log` → existing Telegram chat
7. **Backup restore drill** (PHẢI PASS trước khi go-live):
   - Stop all service trên VM staging riêng (hoặc dùng prod VM với window)
   - Restore từ backup mới nhất
   - Bring up services
   - Verify health + 5 query random
   - Document downtime → RTO actual
8. Write `docs/oncall-runbook.md`:
   - On-call rota (Phase 00 chốt)
   - 5 incident playbook: VL down, Qdrant corrupted, LLM 429, indexer stuck, web 500
   - Escalation path
9. Run pager test: fake alert → confirm oncall nhận

## Todo
- [ ] VictoriaMetrics + Grafana up
- [ ] /api/metrics route web
- [ ] Dashboard 6 panel
- [ ] Infra vmalert rules + Alertmanager route oncall
- [ ] Backup restore drill PASS + RTO documented
- [ ] Runbook 1 trang committed
- [ ] Pager test passes

## Success criteria
- Dashboard hiển thị 6 metric, no panel empty/error
- Test alert fire trong < 30s đến oncall channel
- Backup restore drill: full recovery < 1h, 0 data loss (theo RPO 24h)
- Runbook readable bởi engineer chưa biết hệ thống

## Risks
- Backup restore drill fail → block go-live, fix backup script trước
- Alert fatigue nếu rule quá nhạy → tune threshold sau 1 tuần
- VictoriaMetrics + Grafana thêm 2-4 GB RAM → kiểm tra VM còn đủ

## Security
- Grafana auth qua corp OIDC (cùng IdP với Web)
- Alert webhook authenticated (token shared)
- Backup drill data sample không chứa PII thật → dùng staging với mock

## Next steps
- Phase 07 soak: dashboard là tool chính monitor
- Sau soak: review alert noise, tune
