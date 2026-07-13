---
name: vmalert-rules-phase1-selfcheck-web
status: deployed-monitoring
created: 2026-07-13
updated: 2026-07-13
owner: trihd@inet.vn
deployedAt: 2026-07-13T16:30:00+07:00
deployCommit: e8a7c5d
blockedBy: []
blocks: []
relatedReports:
  - plans/reports/brainstorm-260713-1520-vmalert-rules-gap-review.md
relatedPlans:
  - plans/260710-1432-logserver-rotation-a-plus-e
tags: [observability, vmalert, prod-readiness, alerts]
---

# Plan: vmalert rules Phase 1 — self-check + web stack

## Mục tiêu

Vá silent-failure gap trong prod log-server observability. **Scope điều chỉnh sau red-team review 2026-07-13 15:44** — drop 2 rules cần extend Vector config sang P2 backlog.

### Phase 1a — Deploy ngay (4 rules)

**Rule loại B (presence/binary detection — đúng bất kể volume):**
- FileDescriptorExhaustion — EMFILE / ulimit chạm
- PhpFpmWorkerExhaustion — pm.max_children reached (matcher chặt lại: exact php-fpm format)
- LsphpSegfault — PHP crash — **severity=critical, threshold >0** (segfault = bug)

**Rule loại A với threshold conservative:**
- VictoriaLogsSelfError — VL container err burst (threshold >10/2m khởi tạo)

### Phase 1b — Defer (3 rules, cần dependency khác)

| Rule | Blocker |
|---|---|
| WebServer4xxFlood | Cần baseline real traffic 1-2 tuần |
| **HostLogSilent** | **LogsQL `stats by (host)` không emit row cho host silent** → cần Vector expose Prometheus metrics + vmagent scrape. Vector config hiện chưa có → gap infra riêng |
| **DockerContainerRestartLoop** | Vector hiện chỉ scrape `docker_litellm` container, không scrape Docker daemon events general → cần extend Vector source (journald hoặc docker socket global) |

## Context

- Brainstorm (source of truth): [brainstorm-260713-1520-vmalert-rules-gap-review.md](../reports/brainstorm-260713-1520-vmalert-rules-gap-review.md)
- Stack: MySQL + Nginx mock + LLM + **OpenLitespeed + php-fpm + lsphp**
- Related config: [infra/vmalert/rules.yml](../../infra/vmalert/rules.yml), [infra/alertmanager/alertmanager.yml](../../infra/alertmanager/alertmanager.yml)
- User đã chấp nhận rủi ro skip DMS (Dead Man's Switch) — external monitor. Documented as known gap.
- Vừa tune alertmanager repeat_interval hôm nay (warning=2h, critical=30m).

## Known gaps NOT in this plan (Phase 2+)

| Gap | Reason defer |
|---|---|
| **HostLogSilent (P2)** | Cần add `sources.internal_metrics` + `sinks.prometheus_exporter` vào Vector config, vmagent scrape endpoint. Rule metric-based dùng `absent(up{host=X})`. |
| **DockerContainerRestartLoop (P2)** | Cần extend Vector `sources` — scrape journald service=docker HOẶC docker_logs với include=* thay vì chỉ litellm |
| Dead Man's Switch | User chấp nhận rủi ro 2026-07-13, cần external service |
| Cert expiry probe | Chưa xác định TLS endpoint cần watch |
| Backup job failure | Cần biết backup schedule + exit code emit ở đâu |
| Alertmanager inhibition rules | Reduce spam khi incident lớn, nice-to-have |
| Threshold baseline tuning | Cần 2 tuần prod data mới tính p95 |
| Runbook URL annotations | Cosmetic |

## Phases

**Reorder sau red-team H5:** Phase 06 (fix mock rules DEAD trong prod) chạy TRƯỚC Phase 02 vì gap này nghiêm trọng hơn.

| # | Phase | Status | Effort |
|---|---|---|---|
| 01 | Verify service labels + Vector sources | partial (skipped auditd) | 20m |
| 06 | **Fix 3/4 mock rules** — SshBrute, MysqlBurst, WebServerErrorBurst extended (AuditLogin deferred P2) | ✅ done | 20m |
| 02 | Add 4 rules Phase 1a + dry-run validation | ✅ done | 25m |
| 03 | Deploy + reload vmalert (dry-run pre-check) | ✅ done 2026-07-13 16:30 | 15m |
| 04 | Fake-log inject tests (all 4 rules) | pending | 30m |
| 05 | 24h staging observation + tune | pending | ongoing |
| — | **Phase 1b defer:** WebServer4xxFlood + HostLogSilent + DockerRestart | deferred | - |

## Dependencies (post red-team reorder)

- Phase 01 → Phase 06 + Phase 02 (labels + Vector sources confirmed)
- Phase 06 → Phase 02 (fix mock rules trước, add new sau — cùng file rules.yml)
- Phase 02 → Phase 03 (dry-run validate + git push)
- Phase 03 → Phase 04 (vmalert alive để inject test)
- Phase 04 → Phase 05 (rules validated → observe baseline)

## Success criteria

- 4 rules Phase 1a parse OK sau dry-run + reload
- Fake-log inject test 4/4 rules fire đúng expected latency (<10m). Test data dùng `host:testinject` để filter khỏi query khác.
- LsphpSegfault route qua severity=critical → repeat 30m verified (confirmed user intent 2026-07-13: 1 segfault = bug nghiêm trọng, đáng nhắc 30m/lần)
- Phase 06: 3-4 mock rules extend matcher (AuditLoginFailures conditional — drop nếu `service:auditd` không tồn tại)
- Sync [mockups/onelog-services-detail.html](../../mockups/onelog-services-detail.html) — rule count + rename NginxServerErrors → WebServerErrorBurst
- 3-4 P2 backlog items ghi rõ với blocker cụ thể — sẽ tách sang **plan mới** sau khi Phase 1 complete (không mix)
