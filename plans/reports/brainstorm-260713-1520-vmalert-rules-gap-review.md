# Brainstorm — vmalert rules gap review (prod log-server)

**Date:** 2026-07-13 15:20 Asia/Saigon
**Scope:** review [infra/vmalert/rules.yml](../../infra/vmalert/rules.yml) — đủ chưa cho prod log-server, thiếu rules gì
**Stack context:** MySQL + Nginx (mock) + LLM stack + OpenLitespeed + php-fpm + lsphp. Không có PG/Redis/replica.

---

## 1. Problem statement

Current rules.yml có 27 rules / 6 nhóm — cover tốt *known-known* (SSH brute, OOM, disk, LLM cost) nhưng có **silent-failure gaps** cho chính log pipeline + web stack thực tế (OLS/php-fpm/lsphp). Case bug `mock-logs stopped 3 ngày` đã lộ ra pattern silent regression — cần bổ sung để tránh lặp lại ở scope khác (1/N host im, VL self-error, container restart loop).

---

## 2. Coverage matrix

| Domain | Có (rule count) | Missing |
|---|---|---|
| Security | SSH brute per-host + per-attacker, audit fail, sudo escalation, new user (5) | Root success, cron fail, web 4xx flood, auditd FIM |
| Capacity | OOM, ENOSPC, data disk %, root %, OpenWebUI DB (7) | Memory pre-OOM, inode df -i, **FD exhaustion**, CPU/load |
| Availability | Systemd Failed, DB conn refused, MySQL burst, Nginx 5xx (4) | **Docker restart loop**, PG, cert expiry, backup |
| Log pipeline self | WarnEventsStale, DiskProbeStale, OpenWebUIDbProbeStale (3) | **Per-host silence**, **VL self-err**, Vector sink drop, vmalert eval err, DMS |
| LLM cost | 5 rules | Cache hit low (disabled) |
| Web stack | Nginx err burst | **OLS**, **php-fpm worker exhaustion**, **lsphp segfault** |

---

## 3. Evaluated approaches

### A. Add ALL 8 gaps (comprehensive) — REJECTED
- Pro: full coverage
- Con: over-scope 1-2 ngày, DMS cần external service, threshold tune cần data 2 tuần

### B. Top 5 gaps (KISS) — CHOSEN + expanded
- Pro: ship trong 1 buổi, giá trị cao/effort thấp
- Con: DMS + inhibition rules để Phase 2
- **Adjust:** vì stack có OLS/php-fpm/lsphp → thêm 2 add-on (php-fpm exhaustion + lsphp segfault) → 7 rules total

### C. Minimal (chỉ per-host silence + VL self) — REJECTED
- Pro: siêu KISS
- Con: bỏ qua web stack signals quan trọng, không xứng công deploy

---

## 4. Chosen solution — 7 rules mới (Phase 1)

Add vào [infra/vmalert/rules.yml](../../infra/vmalert/rules.yml). Đề xuất nhóm mới `log-pipeline-selfcheck` + mở rộng nhóm `log-alerts-burst`.

### R1: `HostLogSilent` (per-host silence)
```yaml
- alert: HostLogSilent
  expr: |
    * _time:15m
      | stats by (host) count() as value
      | filter value:<1
  for: 5m
  labels: { severity: warning, category: monitoring, component: log-pipeline }
  annotations:
    summary: "Host {{ $labels.host }} im lặng ≥15m"
    description: "Không có log nào từ {{ $labels.host }} trong 15m. Vector agent chết? Network fail? SSH check ngay. Caveat: rule chỉ fire cho host từng gửi log (không catch host chưa bao giờ join)."
```

### R2: `VictoriaLogsSelfError`
```yaml
- alert: VictoriaLogsSelfError
  expr: |
    service:victorialogs severity:(err OR error OR fatal)
      | stats by (host) count() as value, row_any(_msg) as sample_msg
      | filter value:>5
  for: 2m
  labels: { severity: critical, category: monitoring, component: victorialogs }
  annotations:
    summary: "VictoriaLogs err burst trên {{ $labels.host }}"
    description: "{{ $value }} err từ VL container/5m. Check disk, ingest lag. docker logs ragstack-victorialogs | tail"
```
**Verify:** VL container log có label `service:victorialogs` không → query VMUI `service:victorialogs | limit 10`. Nếu không, sửa Vector source để tag đúng.

### R3: `DockerContainerRestartLoop`
```yaml
- alert: DockerContainerRestartLoop
  expr: |
    (_msg:"container died" OR _msg:"restarting" OR _msg:"exited with code")
      service:docker
      | stats by (host, container_name) count() as value, row_any(_msg) as sample_msg
      | filter value:>5
  for: 5m
  labels: { severity: warning, category: availability, component: docker }
  annotations:
    summary: "Docker container restart loop {{ $labels.container_name }} @ {{ $labels.host }}"
    description: "{{ $value }} restart events/5m. docker logs {{ $labels.container_name }} + docker inspect --format='{{ .State.Health }}'"
```
**Verify:** Vector có source cho Docker daemon events không (`docker_logs` source + labels). Có thể pattern log khác — điều chỉnh matcher.

### R4: `WebServer4xxFlood` (nginx + OpenLitespeed)
```yaml
- alert: WebServer4xxFlood
  expr: |
    (service:mock-nginx OR service:litespeed OR service:openlitespeed OR service:ols)
      (_msg:"401" OR _msg:"403" OR _msg:"404" OR _msg:"429")
      | stats by (host) count() as value, row_any(_msg) as sample_msg
      | filter value:>500
  for: 5m
  labels: { severity: warning, category: security, component: web }
  annotations:
    summary: "Web 4xx flood trên {{ $labels.host }} ({{ $value }}/5m)"
    description: "Threshold 500/5m = 100 req/min 4xx. Bot scan / credential stuffing. Check access log top IPs."
```
**Verify:** service label của OLS access log — có thể là `service:litespeed` hoặc `service:openlitespeed`. Query VL.

### R5: `FileDescriptorExhaustion`
```yaml
- alert: FileDescriptorExhaustion
  expr: |
    (_msg:"Too many open files" OR _msg:"EMFILE" OR _msg:"open file descriptor limit")
      | stats by (host, service) count() as value, row_any(_msg) as sample_msg
      | filter value:>3
  for: 1m
  labels: { severity: warning, category: capacity }
  annotations:
    summary: "FD exhaustion {{ $labels.service }} @ {{ $labels.host }}"
    description: "Nâng ulimit -n hoặc systemd LimitNOFILE. Check /proc/<pid>/limits."
```

### R6: `PhpFpmWorkerExhaustion`
```yaml
- alert: PhpFpmWorkerExhaustion
  expr: |
    (_msg:"max_children" OR _msg:"reached pm.max_children" OR _msg:"server reached")
      | stats by (host) count() as value, row_any(_msg) as sample_msg
      | filter value:>0
  for: 1m
  labels: { severity: warning, category: capacity, component: php-fpm }
  annotations:
    summary: "php-fpm worker exhaustion trên {{ $labels.host }}"
    description: "Pool đầy → request queue tăng → latency spike user-facing. Nâng pm.max_children hoặc thêm pool."
```

### R7: `LsphpSegfault`
```yaml
- alert: LsphpSegfault
  expr: |
    (_msg:"segfault" OR _msg:"segmentation fault") (service:lsphp OR service:litespeed OR _msg:"lsphp")
      | stats by (host) count() as value, row_any(_msg) as sample_msg
      | filter value:>2
  for: 1m
  labels: { severity: warning, category: availability, component: lsphp }
  annotations:
    summary: "lsphp segfault trên {{ $labels.host }}"
    description: "{{ $value }} segfault/1m. PHP extension bug hoặc OPcache corruption. journalctl / lsphp core dump."
```

---

## 5. Implementation considerations & risks

### Threshold rationale (baseline chưa có → tune sau)
| Rule | Threshold | Rationale | Retune sau |
|---|---|---|---|
| HostLogSilent | 0 log/15m | Trắng đen | 30m nếu false positive |
| VLSelfError | 5/2m | Không nên có err VL bình thường | 10 nếu quá nhạy |
| DockerRestart | 5/5m | 1-2 restart chấp nhận, 5+ = loop | Tune theo services thực |
| Web4xxFlood | 500/5m | ≈100 rpm 4xx — bot signal | Baseline access log 1 tuần |
| FDExhaustion | 3/1m | Rất hiếm | Giữ nguyên |
| PhpFpmExhaust | 0/1m | Bất kỳ event nào cũng đáng warn | Giữ nguyên |
| LsphpSegfault | 2/1m | Isolated segfault ok, burst = bug | Giữ nguyên |

### Rủi ro
1. **Service label mismatch** — nếu VL/Docker/OLS/lsphp không tag đúng `service:`, rule không match → verify TRƯỚC khi ship (query VMUI mỗi service label).
2. **False positive HostLogSilent** — host reboot / maintenance sẽ fire. Cần silence khi planned maintenance.
3. **VMSelfError chicken-egg** — nếu VL sập hoàn toàn thì vmalert cũng không eval được rule này. → Đây là lý do cần DMS (Phase 2 hoặc external).
4. **Docker source availability** — nếu Vector chưa scrape Docker events, R3 luôn không data → Inactive vô tận. Verify Vector config.

### Deploy path
1. Verify service labels trong VMUI (`service:victorialogs`, `service:docker`, `service:litespeed`, `service:lsphp`).
2. Add 7 rules vào rules.yml — group `log-alerts-burst` (R4-R7) và group mới `log-pipeline-selfcheck` (R1-R3).
3. Reload vmalert: `docker compose -f infra/docker-compose.yml --profile alerts up -d --force-recreate vmalert`.
4. Verify parse OK: `curl -s http://localhost:8880/api/v1/rules | python3 -m json.tool | grep -E "name|state"`.
5. Monitor 24h → tune threshold nếu spam.

---

## 6. Known gaps (Phase 2+, ghi lại kẻo quên)

| Gap | Priority | Ghi chú |
|---|---|---|
| Dead Man's Switch | **User chấp nhận rủi ro (2026-07-13)** | Nếu log-server + AM cùng sập, không ai biết. Reconsider khi có PagerDuty/healthchecks.io |
| Cert expiry | P2 | Cron `openssl x509 -enddate` → emit log warning nếu <14d |
| Backup job failure | P2 | Cần biết backup schedule + exit code emit ở đâu |
| Alertmanager inhibition | P2 | Suppress child alerts khi parent firing (MysqlDown → suppress ErrorBurst/ConnRefused) |
| Threshold baseline tune | Ongoing | Sau 2 tuần prod data, tính p95 lại |
| Runbook URLs | Nice-to-have | Thêm `annotations.runbook_url` link docs/ |
| Memory pre-OOM | P3 | Cần node exporter metrics, không phải log-based |
| Inode exhaustion | P3 | Cần probe `df -i` — extend disk probe |

---

## 7. Success criteria

- 7 rules parse OK (`vmalert api/v1/rules` không có error state)
- Manual trigger test:
  - Stop Vector trên 1 client 20m → `HostLogSilent` fire
  - `docker kill` 1 container → tự restart 6 lần → `DockerContainerRestartLoop` fire
  - `siege` 100 req/s vào endpoint 404 → `WebServer4xxFlood` fire trong 5m
- Không false positive trong 24h đầu (baseline observation)
- Alertmanager route đúng theo severity (warning → 2h, critical → 30m) sau tune hôm nay

---

## 8. Unresolved questions

1. **Vector đã scrape Docker daemon events chưa?** Nếu chưa → R3 sẽ dead. Cần check `infra/vector/vector.yaml` (source docker_logs) trước khi ship.
2. **Service label chính xác của OpenLitespeed access log?** `litespeed` / `openlitespeed` / `ols` / `httpd` — cần query VL confirm.
3. **php-fpm/lsphp log path forward vào VL?** Nếu OLS log vào file riêng chưa được Vector tail thì rule bất lực.
4. **Có host list "expected" nào để so với HostLogSilent không?** Hiện đang trust "host đã từng gửi" — có thể miss host chưa join.
5. **Threshold 500/5m WebServer4xxFlood có phù hợp OLS traffic prod không?** — cần 1 tuần baseline access log volume.
