# vmalert Phase 1a deployed — 4 new rules + 3 extended matchers

**Date:** 2026-07-13  
**Plan:** [260713-1520-vmalert-rules-phase1-selfcheck-web](../../plans/260713-1520-vmalert-rules-phase1-selfcheck-web/)  
**Commit:** `e8a7c5d`  
**Status:** ✅ Deployed to logserver.

## What shipped

### New rules (Phase 1a) — total 32 active rules now
- **VictoriaLogsSelfError** (group: log-pipeline-selfcheck, severity: critical, threshold: >10/2m, for: 2m)  
  Catches VL indexing stalls. Fires when VL emits `error` + `index_insert` log simultaneously.
- **FileDescriptorExhaustion** (group: log-alerts-burst, severity: warning, threshold: >3/5m, for: 5m)  
  Process fd limit exhaustion detected via `ulimit` probe logs.
- **PhpFpmWorkerExhaustion** (group: log-alerts-burst, severity: warning, threshold: >0/5m, for: 5m)  
  PHP-FPM pool depleted (pool.emergency_restart_threshold breach).
- **LsphpSegfault** (group: log-alerts-instant, severity: critical, threshold: >0/1m, for: 30s, notify_style: event)  
  Single LiteSpeed LSPHP segfault escalates immediately to Telegram critical thread.

**Total Phase 1 rules:** 32 (Phase 06 disk-alerts: 5, Phase 1a: 4 new + 3 extended = 7 cumulative change).

### Extended matchers (Phase 06) — real prod services included
Three rules previously matched mock-only services; now OR real prod:
- **SshBruteForce**: `mock-sshd` → now also `sshd`, `ssh`, `mock-sshd`
- **MysqlErrorBurst**: `mock-mysql` → now also `mysqld`, `mysql`, `mock-mysql`  
- **WebServerErrorBurst** (renamed from **NginxServerErrors**): `mock-nginx` → now also `litespeed`, `openlitespeed`, `nginx`, `mock-nginx`

### Alertmanager tuning (same session)
- `repeat_interval`: warning=2h, critical=30m (commit before e8a7c5d)  
  Prevents alert fatigue while maintaining critical visibility.

## Deferred to Phase 2 (documented in plan)
- **HostLogSilent** — needs Vector Prometheus metrics scrape
- **DockerContainerRestartLoop** — needs Vector docker daemon scrape (currently only litespeed docker_litellm)
- **WebServer4xxFlood** — needs real prod traffic baseline for threshold tuning
- **AuditLoginFailures matcher extend** — conditional on auditd label verification; Phase 01 check deferred

Plan 2 will be created separately after Phase 1 full soak (48-72h).

## Verification

Use `infra/vmalert/rules.yml` to list all 32 rules by group:
```bash
grep -c "^  - alert:" infra/vmalert/rules.yml  # Expect: 32
```

Per-group count:
```bash
grep "^  name:" infra/vmalert/rules.yml
# Expect: disk-alerts (5), log-pipeline-selfcheck (1), log-alerts-burst (2), log-alerts-instant (1), llm_cost (≥5), ...
```

Test rule state via API (post-deploy):
```bash
curl -s http://127.0.0.1:8880/api/v1/rules | jq '.data.groups[].name' | sort
# Should include: disk-alerts, log-pipeline-selfcheck, log-alerts-burst, log-alerts-instant, ...
```

## Notes for next cook

1. **Rule matchers are now heterogeneous** — disk-alerts = single service names, log-* rules = multi-service OR. Keep extend operations explicit in commit message.
2. **LsphpSegfault notify_style=event** unusual choice — confirmed intentional (team decision: every segfault ≥ critical priority).
3. **Fake-log inject approved** (validation V2) — test logs tagged `host:testinject` auto-cleanup via VL 30d retention. No manual delete needed.
4. **Phase 2 trigger:** After 48h baseline soak, create plan `260XXX-vector-source-extension-p2` for 4 deferred rules.

## Lessons

- Red-team §5 (commit pinpoint workflow) → identified phase 05 "tune Alertmanager" as separate from vmalert rules deploy. Shipped both same session.
- Validation §V3 confirmed severity=critical for single segfault intentional; don't optimize away.
