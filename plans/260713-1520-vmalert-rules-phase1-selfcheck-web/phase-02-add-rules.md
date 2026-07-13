# Phase 02 — Add 4 rules (Phase 1a) vào rules.yml

**Priority:** Core deliverable
**Effort:** ~25m
**Status:** pending
**Blocked by:** Phase 01 (labels + Vector sources confirmed), Phase 06 (mock rules extended)

## Mục tiêu

Add **4 rules Phase 1a** vào [infra/vmalert/rules.yml](../../infra/vmalert/rules.yml).

- **New group `log-pipeline-selfcheck`** (interval 5m): VictoriaLogsSelfError
- **Extend group `log-alerts-burst`**: FDExhaustion, PhpFpmExhaust
- **Extend group `log-alerts-instant`**: LsphpSegfault (post code-review: segfault critical + notify_style=event → thuộc instant group để sub-1m latency)

**Deferred to P2** (red-team decision 2026-07-13): HostLogSilent (LogsQL semantic bug, cần Vector metrics), DockerContainerRestartLoop (Vector chưa scrape Docker daemon events). WebServer4xxFlood defer 1-2 tuần chờ baseline.

## Files to modify

- `infra/vmalert/rules.yml` — add 7 rules
- `mockups/onelog-services-detail.html` — update rule count (nếu có block đếm)

## Implementation

### Group mới: `log-pipeline-selfcheck`

Thêm block này SAU group `disk-alerts`, TRƯỚC group `semantic-pipeline`:

```yaml
  # ─────────────────────────────────────────────────────────────────────────
  # LOG PIPELINE SELFCHECK — detect silent failures của chính pipeline.
  # Bổ sung 2026-07-13. Xem plans/260713-1520-vmalert-rules-phase1-selfcheck-web/
  # NOTE: HostLogSilent + DockerRestartLoop defer P2 — cần extend Vector config.
  # ─────────────────────────────────────────────────────────────────────────
  - name: log-pipeline-selfcheck
    type: vlogs
    interval: 5m
    rules:
      # VictoriaLogs self-error: VL container báo err = disk / ingest issue.
      # Chicken-egg: VL sập hoàn toàn → rule không eval. Documented gap.
      # Verify: service label chính xác trong Phase 01.
      - alert: VictoriaLogsSelfError
        expr: |
          service:victorialogs severity:(err OR error OR fatal)
            | stats by (host) count() as value, row_any(_msg) as sample_msg
            | filter value:>10
        for: 2m
        labels:
          severity: critical
          category: monitoring
          component: victorialogs
        annotations:
          summary: "VictoriaLogs err burst trên {{ $labels.host }} ({{ $value }}/2m)"
          description: "VL container báo err. Check disk / ingest lag: docker logs ragstack-victorialogs | tail -100"
```

### Extend group `log-alerts-burst`

Thêm 3 rules này (Phase 1a) vào cuối rules list của group `log-alerts-burst` (sau `DbConnectionRefused`). **WebServer4xxFlood defer sang Phase 1b — không add trong lần này.**

```yaml
      # File descriptor exhaustion: EMFILE / ulimit chạm.
      - alert: FileDescriptorExhaustion
        expr: |
          (_msg:"Too many open files" OR _msg:"EMFILE" OR _msg:"open file descriptor limit")
            | stats by (host, service) count() as value, row_any(_msg) as sample_msg
            | filter value:>3
        for: 1m
        labels:
          severity: warning
          category: capacity
        annotations:
          summary: "FD exhaustion {{ $labels.service }} @ {{ $labels.host }}"
          description: "Nâng ulimit -n hoặc systemd LimitNOFILE. Check /proc/<pid>/limits."

      # php-fpm worker pool exhaustion: pm.max_children reached → latency spike.
      # Matcher chặt: dùng exact php-fpm log format để tránh false positive từ
      # debug/docs/backup logs. Red-team M1 fix.
      - alert: PhpFpmWorkerExhaustion
        expr: |
          _msg:"server reached pm.max_children"
            | stats by (host) count() as value, row_any(_msg) as sample_msg
            | filter value:>0
        for: 1m
        labels:
          severity: warning
          category: capacity
          component: php-fpm
        annotations:
          summary: "php-fpm worker exhaustion trên {{ $labels.host }}"
          description: "Pool đầy → user-facing latency spike. Nâng pm.max_children hoặc thêm pool."

      # lsphp segfault: PHP extension bug / OPcache corruption.
      # Red-team H2 fix: severity=critical, threshold >0, for=30s.
      # Rationale: 1 segfault = bug đáng biết ngay, không đợi burst.
      - alert: LsphpSegfault
        expr: |
          (_msg:"segfault" OR _msg:"segmentation fault") (service:lsphp OR service:litespeed OR _msg:"lsphp")
            | stats by (host) count() as value, row_any(_msg) as sample_msg
            | filter value:>0
        for: 30s
        labels:
          severity: critical
          category: availability
          component: lsphp
        annotations:
          summary: "lsphp segfault trên {{ $labels.host }} ({{ $value }})"
          description: "PHP extension bug hoặc OPcache corruption. journalctl -xe / core dump."
```

## Todo

- [ ] Update matcher rules theo Phase 01 output (nếu label khác dự đoán)
- [ ] Add group `log-pipeline-selfcheck` vào rules.yml (1 rule: VLSelfError)
- [ ] Add 3 rules vào cuối group `log-alerts-burst` (FDExhaust, PhpFpm, LsphpSegfault)
- [ ] YAML lint check (indent 2 spaces, không tab)
- [ ] **Dry-run validate rules.yml** trước khi commit:
  ```bash
  docker run --rm -v $(pwd)/infra/vmalert/rules.yml:/rules.yml \
    victoriametrics/vmalert:latest \
    -rule=/rules.yml -notifier.url=http://localhost:9093 -datasource.url=http://localhost:9428/ -dryRun
  ```
  → phải exit 0, không có `parse error` / `unknown field`
- [ ] Git commit: `feat(vmalert): add 4 rules Phase 1a — VL selfcheck + php stack`

## Success

- YAML parse OK (local check: `python3 -c "import yaml; yaml.safe_load(open('infra/vmalert/rules.yml'))"`)
- Diff review: 7 rules added, không sửa rules cũ

## Next phase

→ [phase-03-deploy-reload.md](phase-03-deploy-reload.md)
