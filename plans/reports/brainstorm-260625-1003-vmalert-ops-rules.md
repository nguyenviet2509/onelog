# Brainstorm: vmalert ops-driven rules (round 2)

**Date:** 2026-06-25 10:03 (+07)
**Branch:** master
**Status:** Approved — cooking 5 rules
**Owner:** vietnt
**Context stack:** Linux + DB (MySQL/PG/Redis) + Web/App (Nginx/HAProxy). Prom + Grafana đã có.

---

## Problem
Rules.yml hiện có 7 rule (security 3 + app 3 + sudo 1). Coverage thiếu capacity events
(disk/OOM) và service availability events (systemd crash, DB conn refused) — đây là
top fire-fight ops thật.

## Filter principle
- Log alert chỉ cho EVENT (sự kiện xảy ra), state (CPU/mem %) đẩy Prometheus.
- High signal, low FP, actionable < 5m.

## Rules cooked (5)

| # | Rule | Category | Expr (LogsQL) | Threshold |
|---|---|---|---|---|
| 1 | `DiskFullErrors` | Capacity | `(_msg:"No space left" OR _msg:"ENOSPC" OR _msg:"disk full") \| stats by (host) count() as value \| filter value:>1` | >1/5m |
| 2 | `OomKillEvent` | Capacity | `facility:kern (_msg:"oom-killer" OR _msg:"Out of memory: Killed") \| stats by (host) count() as value \| filter value:>0` | any |
| 3 | `SystemdServiceFailed` | Availability | `_msg:"Failed with result" \| stats by (host) count() as value \| filter value:>2` | >2/5m |
| 4 | `DbConnectionRefused` | Availability | `(_msg:"connection refused" OR _msg:"could not connect to" OR _msg:"can't connect to MySQL" OR _msg:"FATAL: connection") \| stats by (host) count() as value \| filter value:>5` | >5/5m |
| 6 | `NewUserOrSudoer` | Security/Audit | `facility:auth (_msg:"new user:" OR _msg:"to group 'sudo'" OR _msg:"to group 'wheel'" OR _msg:"useradd" OR _msg:"usermod") \| stats by (host) count() as value \| filter value:>0` | any |

## Skipped
- **#5 DirectRootLogin** — team chưa có policy cấm root SSH → FP rate quá cao.

## NOT recommended (delegate to Prom)
- CPU/Mem/Disk % → node_exporter
- Container restart loop → cAdvisor / kube-state-metrics
- TLS cert expiry → blackbox_exporter
- Pipeline health (Vector down) → Prom `up{}` (plan observability-integration đang lo)

## Risks
- Rule 3: service tag cho systemd có thể khác trên distro cũ → verify VL UI sau deploy.
- Rule 4: regex string-match từng DB driver — sẽ miss khi onboard DB client mới (psycopg3 / etc.). Tune từng đợt.
- Rule 6: auditd chuẩn hơn nhưng cần install + config — KISS giữ regex-based MVP.

## Threshold tuning protocol
Sau cook: observe 1 tuần, query LogsQL lịch sử để xác định p95, set threshold = 2×p95.
Trong thời gian observe: tăng `for: 30m` thay vì `1m` để tránh fire spam.

## Unresolved
- Alertmanager route có category `audit`, `system` chưa? Cần audit `infra/alertmanager/alertmanager.yml`.
- vmalert profile `alerts` opt-in — production lab có bật hằng ngày không?
