---
name: logserver-rotation-a-plus-e
status: pending
created: 2026-07-10
updated: 2026-07-10
owner: trihd@inet.vn
blockedBy: []
blocks: []
relatedReports:
  - plans/reports/audit-260710-0854-prod-readiness-full.md
  - plans/reports/brainstorm-260710-1432-logserver-rotation-strategy.md
relatedPlans:
  - plans/260624-1417-observability-integration
tags: [prod-readiness, ops, disk-safety]
---

# Plan: LogServer rotation A + E — Docker log rotate + disk alerts

## Mục tiêu

Trước khi deploy prod scale-up (10-500 clients), khép 2 gap an toàn về disk:

- **A**: Docker json-file log rotation ở host level (`/etc/docker/daemon.json`) → tránh `/` partition (98 GB) đầy do container spam stdout.
- **E**: 2-tier disk alert rules (warning@75%/for:15m + critical@88%/for:0) cho cả `/` và `/opt/ragstack/data` → visibility trước khi vỡ disk.

Defer B/C/D (NATS max_bytes, VL retention dynamic, backup tách VL) — làm reactive khi trigger fire.

## Context

- Brainstorm: [brainstorm-260710-1432-logserver-rotation-strategy.md](../reports/brainstorm-260710-1432-logserver-rotation-strategy.md)
- Audit gốc: [audit-260710-0854-prod-readiness-full.md](../reports/audit-260710-0854-prod-readiness-full.md)
- VPS specs: 8 vCPU / 31 GB RAM / 98 GB `/` + 905 GB `/opt/ragstack/data`
- Kết luận brainstorm: VL ZSTD compression đủ mạnh (10-40x) cho 500-1000 clients @ 30d retention trên 905 GB. Rủi ro thật nằm ở docker log unbounded + không có visibility.

## Design decisions (post red-team + validate)

### 1. Probe topology: 2 nguồn riêng biệt

**Data disk `/opt/ragstack/data`** → Vector `exec` probe với bind mount **narrow**:
```yaml
- /opt/ragstack/data:/host/data:ro,rslave
```
KHÔNG bind full `/` vì cùng lúc với existing `docker.sock` mount = container takeover primitive (Vector RCE → dump `.env` → spawn privileged container).

**Root partition `/`** → host-side cron script `probe-host-disk-root.sh` curl JSON event vào VL. Chạy ngoài container Vector → không cần bind rootfs. 5m interval trùng cadence.

### 2. LogsQL syntax — dùng precedent hiện có

- `max(used_pct)` thay `last()` (precedent `rules.yml:187` dùng `max`).
- Explicit `_time:15m` filter (commit d55a6d6 chứng minh vmalert vlogs KHÔNG inject window).
- `filter value:>75` WORD syntax (khớp precedent llm_cost + openwebui-db). Math `filter value > 75` **KHÔNG parse** trong LogsQL VL đang chạy — test-runtime FAIL.
- LogsQL không hỗ trợ negative threshold (`filter value:>-1`) — luôn dùng threshold dương.
- Space-separated implicit AND giữa `service:X source_stream:Y` — không dùng explicit `AND` keyword.

### 3. Alert tier — 2 severity level

| Rule | Mount | Threshold | For | Severity |
|---|---|---|---|---|
| DiskDataHighWarn | `/opt/ragstack/data` | > 75% | 15m | warning |
| DiskDataHighCrit | `/opt/ragstack/data` | > 88% | 0s | critical |
| DiskRootHighWarn | `/` | > 75% | 15m | warning |
| DiskRootHighCrit | `/` | > 88% | 0s | critical |
| DiskProbeStale | any | probe silent > 20m | 1m | warning |

### 4. Systemd interaction cho Docker restart

`ragstack.service` có `Requires=docker.service` → restart docker cascade stop ragstack. Flow đúng:
```
systemctl stop ragstack → systemctl restart docker → systemctl start ragstack
```
Exclude 02:00-02:30 window (snapshot cron).

## Phases

| # | Phase | Effort | Status | File |
|---|---|---|---|---|
| 01 | Docker host log rotate | ~15m | pending | [phase-01-docker-log-rotate.md](phase-01-docker-log-rotate.md) |
| 02 | Vector probe + host probe + vmalert rules | ~35m | pending | [phase-02-vector-df-probe-vmalert-rules.md](phase-02-vector-df-probe-vmalert-rules.md) |
| 03 | Docs + mockup sync | ~15m | pending | [phase-03-docs-mockup-sync.md](phase-03-docs-mockup-sync.md) |

**Tổng effort**: ~65 phút.

## Golden rules

- Không đụng behavior service hiện tại. Chỉ **thêm** rules/probe/config, không sửa/xóa cái đang chạy.
- Mỗi phase phải **rollback được** bằng lệnh cụ thể (revert file + restart service).
- Verify sau mỗi phase trước khi làm phase tiếp.
- Không auto-execute — ops chạy tay theo phase file.

## Success criteria

- **A**: `docker inspect <container> --format '{{.HostConfig.LogConfig.Config}}'` return `max-size:10m max-file:3` cho mọi container.
- **E**: `curl 'http://127.0.0.1:8880/api/v1/rules' | jq` list 5 rules disk-alerts với state hợp lệ (inactive baseline hoặc firing khi test).
- Force test (lower threshold): tạm hạ DiskRootHighWarn `filter value:>75` → `filter value:>10` + `for:15m` → `for:0s` (root=29% baseline sẽ fire trong 5-10 phút). DiskDataHighWarn không dùng để test được (data disk baseline 0% → không > 1).
- 3 tháng post-deploy: không có disk full surprise, alert fire ≥ 1 lần khi VL retention đạt 75% baseline.

## Risk assessment (post red-team)

| Risk | Mitigation |
|---|---|
| Restart docker daemon downtime ~1-2 phút | `systemctl stop ragstack` trước, exclude 02:00-02:30 cron window. Verify snapshot cron `pgrep -f snapshot-daily` = empty. |
| daemon.json JSON valid but config invalid | `dockerd --validate --config-file /etc/docker/daemon.json` pre-flight (Docker 20.10+). |
| jq shallow merge overwrite existing log-opts | Dùng deep merge pattern `.["log-opts"] = ((."log-opts" // {}) + {...})`. Diff review trước restart. |
| Vector container mất log ~10s khi recreate | UDP syslog packet loss chấp nhận được. Log-alerts-instant rule `_time:` window đủ tolerate gap. |
| Rules LogsQL syntax sai → group parse-error | vmalert `-dryRun` HARD gate trước reload. Test 1 rule ở vmui trước khi commit. |
| Host `/` probe cron fail silent | DiskProbeStale rule (probe không emit > 20m) cover. |
| False positive alert khi backup snapshot fill tạm | Threshold 75% + `for: 15m` filter noise. Snapshot cleanup < 5 phút. |

## Rollback (full)

```bash
# Phase 03 rollback (docs)
git checkout HEAD -- mockups/onelog-client-deploy-config.html docs/deployment-guide.md

# Phase 02 rollback
git checkout HEAD -- infra/vector/vector.yaml infra/vmalert/rules.yml infra/docker-compose.yml
rm infra/vector/probe-logserver-disk.sh
rm infra/scripts/probe-host-disk-root.sh
sudo crontab -l | grep -v 'probe-host-disk-root' | sudo crontab -
cd ~/onelog/infra
docker compose --profile agent --profile indexer --profile alerts \
  --profile llm --profile chat --profile dashboard up -d --force-recreate vector
docker compose --profile alerts restart vmalert

# Phase 01 rollback
sudo systemctl stop ragstack
sudo cp /etc/docker/daemon.json.bak /etc/docker/daemon.json   # hoặc rm nếu không có bak
sudo systemctl restart docker
sudo systemctl start ragstack
# Verify state matches pre-plan
for c in $(docker compose ps -q); do
  docker inspect --format '{{.Name}} → {{.HostConfig.LogConfig}}' $c
done
```

## Out of scope (defer triggers)

| Fix | Trigger để làm |
|---|---|
| B. NATS max_bytes | `docker exec ragstack-nats nats stream info LOGS` → messages > 5M hoặc bytes > 20 GB |
| C. VL retention dynamic (7d → 3d/1d) | Rule `vl_data_size_bytes / vl_data_max_bytes > 0.8` fire (đã plan trong observability-integration) |
| D. Backup tách VL data | Backup archive > 300 GB / snapshot |

## Red Team Review

### Session — 2026-07-10
**Findings:** 30 raw → 15 unique after dedup (14 accepted, 1 rejected)
**Severity breakdown:** 5 Critical, 7 High, 3 Medium

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Bind mount propagation missing rslave | Critical | Accept | Phase 2 — narrow bind /opt/ragstack/data:ro,rslave |
| 2 | Host takeover: /host/rootfs + docker.sock | Critical | Accept | Phase 2 — removed rootfs bind, host-side cron for `/` |
| 3 | LogsQL: missing _time, unverified last(), wrong filter syntax | Critical | Accept | Phase 2 — max() + _time:15m + `value > N` |
| 4 | Sink name `vl_monitor` không tồn tại | Critical | Accept | Phase 2 — đổi thành `victorialogs` |
| 5 | Systemd Requires=docker.service cascade | Critical | Accept | Phase 1 — stop ragstack trước restart docker |
| 6 | jq shallow merge overwrite log-opts | High | Accept | Phase 1 — deep merge + diff review |
| 7 | Docker restart no auto-rollback for daemon fail | High | Accept | Phase 1 — dockerd --validate + auto-restore wrapper |
| 8 | dd fill 200GB test dangerous | High | Accept | Phase 2 — primary: lower threshold; fallback: 5GB file |
| 9 | Rollback inconsistencies | High | Accept | plan.md + Phase 1/2 — added docker-compose.yml, profile list, verify loop |
| 10 | Partial-apply breaks vector pipeline | High | Accept | Phase 2 — reorder: probe first, standalone test, then yaml edit |
| 11 | Alert lag 20-30 min cho `/` critical | High | Accept | Phase 2 — split 2-tier warning + critical for:0 |
| 12 | Log injection forgeable service tag | High | Accept | Phase 2 — source_stream marker + filter |
| 13 | Probe robustness (JSON escape, no stale alert) | Medium | Accept | Phase 2 — awk gsub + DiskProbeStale rule |
| 14 | SIGHUP claim wrong | Medium | Accept | Phase 2 — corrected requirement text ~10s gap |
| 15 | Math error 14×30MB → 620MB | Medium | Accept | Phase 1 — corrected to 40MB × 14 ≈ 620MB |
| 16 | `dc` alias assumed | Medium | Reject | — assume ops shell has alias, note in phase |

## Validation Log

### Session 1 — 2026-07-10

**Q1: Bind mount scope cho Vector probe df?**
- **Answer:** Narrow: chỉ `/opt/ragstack/data` (Recommended)
- **Impact:** Phase 2 rewrite — bind `/opt/ragstack/data:/host/data:ro,rslave` thay `/`. Root `/` monitor qua host-side cron script (probe-host-disk-root.sh) curl vào VL. Không expose `.env`, `/root/.ssh`, docker containers config.

**Q2: Split alert cho `/` root partition?**
- **Answer:** 2-tier: warning@75%/for:15m + critical@88%/for:0 (Recommended)
- **Impact:** Phase 2 — 4 rules trong `disk-alerts` group thay 2. DiskDataHighWarn/Crit + DiskRootHighWarn/Crit. Cộng DiskProbeStale = 5 rules.

**Q3: Systemd interaction khi restart docker?**
- **Answer:** Stop ragstack.service trước, restart docker, start lại (Recommended)
- **Impact:** Phase 1 — sequence `stop ragstack → restart docker → start ragstack`. Pre-flight check `pgrep -f snapshot-daily` empty. Exclude 02:00-02:30 window.

## Post-plan additions (2026-07-10 → 2026-07-13)

Ba thay đổi bổ sung SAU khi plan v1 completed — capture ở đây để không lạc:

### 1. Alertmanager route disk-alerts → Log-Server topic (commit `5627162`)

`disk-alerts` group ban đầu rơi vào default receiver `telegram-trend` → Client-Server topic. Ops đã tạo Telegram topic dedicated "Log-Server" (thread 15) → cần route đúng.

**Change**: thêm matcher vào `infra/alertmanager/alertmanager.yml`:
```yaml
- matchers:
    - component=~"data-disk|root-partition|disk-probe"
  receiver: telegram-llm-cost   # → TELEGRAM_ALERT_THREAD_ID_LLM_COST (Log-Server thread)
```
Rely trên label `component:` đã set trong 5 rule disk-alerts.

### 2. Telegram topic remapping (ops-side .env)

| Env var | Trước | Sau (Log-Server topic strategy) |
|---|---|---|
| `TELEGRAM_ALERT_THREAD_ID` | Issue alert topic | **Client-Server** thread (id 6) — fleet syslog: OOM, ssh brute, crashloop |
| `TELEGRAM_ALERT_THREAD_ID_LLM_COST` | Quota alert topic | **Log-Server** thread (id 15) — LLM cost + disk-alerts self-monitoring |

⚠️ Env var name `TELEGRAM_ALERT_THREAD_ID_LLM_COST` giờ misleading — dùng chung cho LLM cost + Log-Server disk alerts. Rename semantic (`_LOGSERVER`) là optional cleanup (Wave C — chưa execute).

### 3. DiskProbeStale for: 1m → 5m (commit `db5a6f1`)

Fix warmup transient: Vector exec probe tick 5m nên count trong 20m window mất 15-25m post-boot để đạt threshold 3. `for:1m` gây false-alarm Telegram lần first-deploy. Bump `for:5m` → cần 5 evaluations liên tiếp match (~25m) mới fire → warmup handled.

## Next steps

1. ✅ `/ck:cook --auto` execute plan — DONE 2026-07-10.
2. ✅ Phase 01 (host daemon.json + systemd sequence) applied trên logserver-01 — DONE.
3. ✅ Phase 02 (probes + vmalert rules) + Phase 03 (docs sync) shipped repo + applied host — DONE.
4. ✅ Alertmanager routing + Telegram topic remapping applied — DONE (post-plan).
5. ✅ Force-test PASS: DiskRootHighWarn → Telegram Log-Server thread 15 nhận FIRING + RESOLVED.
6. ⏳ Monitor 24h baseline curve, mark plan `completed` khi ổn.

## Unresolved

- `host_metrics` Vector source option (redesign) không chọn — nếu tương lai cần metric-based monitoring toàn diện, refactor riêng phase.
- vmalert LogsQL `last()` function support: đã bypass bằng `max()`. Nếu team observability plan (blocked) unblock và migrate sang Prometheus type datasource, `last()` sẽ có nghĩa khác.
- Log spike burst 100 clients cùng reboot chưa load-test. Vector default buffer đủ hay không sẽ đánh giá post-deploy.
