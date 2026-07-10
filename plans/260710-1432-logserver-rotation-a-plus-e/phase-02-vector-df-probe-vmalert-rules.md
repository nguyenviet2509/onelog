# Phase 02 — Disk probes + vmalert rules

## Context

- Plan: [plan.md](plan.md)
- Precedent: `infra/vector/probe-openwebui-db.sh` + `openwebui_db_size` exec source (vector.yaml:42-49, 222-236)
- Precedent alert group: `disk-alerts` group mới, follow LogsQL pattern trong `rules.yml:187` (`stats by ... max(...)` + `_time:` explicit filter — commit d55a6d6)

## Overview

**Priority**: HIGH (block prod deploy without visibility)
**Status**: pending
**Effort**: ~35 phút

Post red-team + validate: 2 nguồn probe riêng biệt (narrow bind cho data; host cron cho root) → LogsQL vmalert 5-rule group → Telegram alert.

## Design

### Probe topology

```
┌─────────────────────────────────┐
│ Vector container                │
│  exec probe-logserver-disk.sh   │  bind /opt/ragstack/data:/host/data:ro,rslave
│    → source: logserver_disk_size│  (KHÔNG bind rootfs — security)
│    → transform: parse + tag     │
│    → sink: victorialogs         │
└─────────────────────────────────┘
                 │
                 │  service:logserver-disk-monitor
                 │  source_stream:vector-exec-probe   ← anti-injection marker
                 ↓
       ┌─────────────────┐          ┌────────────────────────────────┐
       │  VictoriaLogs   │  ←─────  │ Host cron 5m                   │
       └─────────────────┘          │  probe-host-disk-root.sh       │
                 │                   │  curl http://vl:9428/insert   │
                 │                   │  service:host-disk-monitor    │
                 ↓                   │  source_stream:host-cron-probe│
       ┌─────────────────┐          └────────────────────────────────┘
       │  vmalert group  │
       │  disk-alerts    │
       │   5 rules       │
       └─────────────────┘
```

### Anti-injection

Rule query filter theo cả `service:` AND `source_stream:` → attacker cần forge cả 2 fields. Vector remap strip `source_stream` khỏi mọi source khác.

## Files to create/modify

**Create**:
- `infra/vector/probe-logserver-disk.sh` (probe data disk, chạy trong Vector container)
- `infra/scripts/probe-host-disk-root.sh` (probe root, chạy host-side cron)

**Modify**:
- `infra/vector/vector.yaml`: source + transform + extend sink `victorialogs` inputs (KHÔNG phải `vl_monitor` — sink đó không tồn tại)
- `infra/docker-compose.yml`: bind mount narrow cho vector service
- `infra/vmalert/rules.yml`: group `disk-alerts` với 5 rules
- Host crontab: cron entry cho probe-host-disk-root.sh

## Implementation steps

### Order of operations (post red-team #10)

1. Tạo probe scripts + chmod
2. Standalone test probe (không đụng vector container)
3. Sửa vector.yaml + docker-compose.yml
4. Sửa vmalert rules
5. Validate configs `vector validate` + `vmalert -dryRun`
6. Apply (recreate vector + restart vmalert)
7. Cài host cron
8. Verify probe emit
9. Verify vmalert loaded
10. Force-test alert

### 1. Tạo `infra/vector/probe-logserver-disk.sh` (data disk)

```sh
#!/bin/sh
# Vector exec source probe — data disk /opt/ragstack/data via bind mount /host/data.
# Chạy trong Vector container (alpine + busybox).
# Bind mount: /opt/ragstack/data:/host/data:ro,rslave (compose khai báo).
set -eu

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
target=/host/data

# Guard: mount thật sự visible (bind + rslave đã đúng)
if ! [ -d "$target" ]; then
  printf '{"_time":"%s","_msg":"disk_probe_error","service":"logserver-disk-monitor","source_stream":"vector-exec-probe","host":"logserver","mount":"/opt/ragstack/data","probe_error":"target_not_mounted"}\n' "$ts"
  exit 0
fi

# `df -PB1` = POSIX + block size 1 byte. tail -n +2 skip header.
# tr '\n' ' ' để join wrapped line (busybox df wraps long device names).
df -PB1 "$target" 2>/dev/null | tail -n +2 | tr '\n' ' ' | awk -v ts="$ts" '
  {
    fs=$1; size=$2; used=$3; avail=$4; used_pct_str=$5;
    # JSON escape backslash + quote cho fs field (mount hard-coded biết là ASCII an toàn)
    gsub(/\\/, "\\\\", fs);
    gsub(/"/, "\\\"", fs);
    # used_pct format "NN%" → strip %
    sub(/%$/, "", used_pct_str);
    if (size == "" || used_pct_str == "") next;
    printf "{\"_time\":\"%s\",\"_msg\":\"disk_usage\",\"service\":\"logserver-disk-monitor\",\"source_stream\":\"vector-exec-probe\",\"host\":\"logserver\",\"mount\":\"/opt/ragstack/data\",\"fs\":\"%s\",\"size_bytes\":%s,\"used_bytes\":%s,\"avail_bytes\":%s,\"used_pct\":%s}\n", ts, fs, size, used, avail, used_pct_str;
  }
'
```

### 2. Tạo `infra/scripts/probe-host-disk-root.sh` (root partition, chạy host)

```sh
#!/bin/sh
# Host-side probe — root partition `/`. Chạy từ cron mỗi 5 phút.
# Curl JSON event trực tiếp vào VictoriaLogs. Không cần Vector container.
# Deploy: symlink hoặc copy vào /usr/local/bin, thêm crontab entry.
set -eu

VL_ENDPOINT="${VL_ENDPOINT:-http://127.0.0.1:9428/insert/jsonline?_stream_fields=service,host}"
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

df -PB1 / 2>/dev/null | tail -n +2 | tr '\n' ' ' | awk -v ts="$ts" -v ep="$VL_ENDPOINT" '
  {
    fs=$1; size=$2; used=$3; avail=$4; used_pct_str=$5;
    gsub(/\\/, "\\\\", fs); gsub(/"/, "\\\"", fs);
    sub(/%$/, "", used_pct_str);
    if (size == "" || used_pct_str == "") exit 1;
    printf "{\"_time\":\"%s\",\"_msg\":\"disk_usage\",\"service\":\"host-disk-monitor\",\"source_stream\":\"host-cron-probe\",\"host\":\"logserver\",\"mount\":\"/\",\"fs\":\"%s\",\"size_bytes\":%s,\"used_bytes\":%s,\"avail_bytes\":%s,\"used_pct\":%s}\n", ts, fs, size, used, avail, used_pct_str;
  }
' | curl -fsS -X POST -H "Content-Type: application/stream+json" --data-binary @- "$VL_ENDPOINT"
```

Chmod + install:
```bash
chmod +x infra/vector/probe-logserver-disk.sh
chmod +x infra/scripts/probe-host-disk-root.sh
```

### 2b. Standalone test probes (TRƯỚC khi đụng vector.yaml)

```bash
# Test 1: Vector probe (giả lập bằng cách bind local)
docker run --rm -v $(pwd)/infra/vector/probe-logserver-disk.sh:/probe.sh:ro \
  -v /opt/ragstack/data:/host/data:ro alpine sh /probe.sh
# Kỳ vọng: 1 dòng JSON valid với used_pct number

# Test 2: Host probe
VL_ENDPOINT=http://127.0.0.1:9428/insert/jsonline bash infra/scripts/probe-host-disk-root.sh
# Kỳ vọng: exit 0, không error curl

# Test 3: Query VL confirm host-cron event nhận
sleep 3
curl -s "http://127.0.0.1:9428/select/logsql/query" \
  --data-urlencode 'query=service:host-disk-monitor _time:5m | limit 5' | jq .
# Kỳ vọng: ≥ 1 event
```

Nếu test 1 fail (bind mount không thấy) hoặc test 2 fail (VL insert reject) → **STOP**, không tiếp bước 3.

### 3. Sửa `infra/docker-compose.yml` service `vector`

Thêm bind vào volumes block (line ~78-91):

```yaml
    volumes:
      - ./vector/vector.yaml:/etc/vector/vector.yaml:ro
      - ./vector/probe-openwebui-db.sh:/etc/vector/probe-openwebui-db.sh:ro
      - ./vector/probe-logserver-disk.sh:/etc/vector/probe-logserver-disk.sh:ro   # NEW
      - ./data/vector:/var/lib/vector
      - ./data/openwebui:/monitor/openwebui:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
      # NEW: narrow bind data disk cho df probe. KHÔNG bind rootfs — bảo vệ secrets.
      # rslave để thấy nested mount nếu /opt/ragstack/data là separate FS.
      - /opt/ragstack/data:/host/data:ro,rslave
```

### 4. Sửa `infra/vector/vector.yaml`

**4a. Thêm source** (sau `openwebui_db_size`, khoảng line 50):

```yaml
  # Host disk usage probe — poll df /opt/ragstack/data mỗi 5m.
  # Bind mount /opt/ragstack/data:/host/data:ro,rslave trong compose.
  logserver_disk_size:
    type: exec
    mode: scheduled
    scheduled:
      exec_interval_secs: 300
    command:
      - /bin/sh
      - /etc/vector/probe-logserver-disk.sh
```

**4b. Thêm transform** (sau `openwebui_db_parse`, khoảng line 236):

```yaml
  # Parse JSON output của probe. Force source_stream field để anti-injection
  # (rule chỉ chấp nhận event có source_stream:vector-exec-probe).
  logserver_disk_parse:
    type: remap
    inputs: [logserver_disk_size]
    source: |
      raw = string(.message) ?? ""
      parsed, err = parse_json(raw)
      if err == null && is_object(parsed) {
        . = object!(parsed)
      } else {
        ._msg = raw
        .service = "logserver-disk-monitor"
        .source_stream = "vector-exec-probe"
        .host = "logserver"
        .parse_error = string(err) ?? "unknown"
      }
      # Đảm bảo source_stream không bị forge từ source khác — set tại đây.
      .source_stream = "vector-exec-probe"
```

**4c. Extend sink `victorialogs`** (line 307-313, KHÔNG phải `vl_monitor` — sink name đó không tồn tại):

Đổi:
```yaml
    inputs: [tag_litellm_cost, openwebui_db_parse, tag_provider_cost]
```
Thành:
```yaml
    inputs: [tag_litellm_cost, openwebui_db_parse, tag_provider_cost, logserver_disk_parse]
```

**4d. (Anti-injection defense-in-depth)**: verify không có transform nào khác set `source_stream` field. Grep `source_stream` trong vector.yaml — chỉ nên xuất hiện ở `logserver_disk_parse`. Nếu có → strip tại các transform khác:
```yaml
      del(.source_stream)   # thêm vào redact/normalize transforms nếu cần
```

### 5. Sửa `infra/vmalert/rules.yml` — append group `disk-alerts`

```yaml
  # ─────────────────────────────────────────────────────────────────────────
  # DISK CAPACITY — 5 rules × 2 tier + probe-stale.
  # LogsQL notes:
  #   - Explicit _time:15m filter (vmalert vlogs KHÔNG inject window, commit d55a6d6).
  #   - Precedent uses max() aggregate (rules.yml:187) — last() not verified in this VL version.
  #   - filter uses math syntax `value > N`, không phải word `value:>N`.
  #   - source_stream: filter chống log injection từ container khác.
  # ─────────────────────────────────────────────────────────────────────────
  - name: disk-alerts
    type: vlogs
    interval: 5m
    rules:
      - alert: DiskDataHighWarn
        expr: 'service:logserver-disk-monitor AND source_stream:vector-exec-probe _time:15m | stats by (mount) max(used_pct) as value | filter value > 75'
        for: 15m
        labels:
          severity: warning
          category: capacity
        annotations:
          summary: "Data disk {{ $labels.mount }} > 75% used"
          description: "/opt/ragstack/data đang {{ $value }}% used. Kiểm tra VL retention hoặc backup archive."

      - alert: DiskDataHighCrit
        expr: 'service:logserver-disk-monitor AND source_stream:vector-exec-probe _time:15m | stats by (mount) max(used_pct) as value | filter value > 88'
        for: 0s
        labels:
          severity: critical
          category: capacity
        annotations:
          summary: "Data disk {{ $labels.mount }} > 88% CRITICAL"
          description: "/opt/ragstack/data đang {{ $value }}% — page immediately. Giảm VL_RETENTION hoặc thêm ổ."

      - alert: DiskRootHighWarn
        expr: 'service:host-disk-monitor AND source_stream:host-cron-probe _time:15m | stats by (mount) max(used_pct) as value | filter value > 75'
        for: 15m
        labels:
          severity: warning
          category: capacity
        annotations:
          summary: "Root partition {{ $labels.mount }} > 75% used"
          description: "/ (98GB OS) đang {{ $value }}%. Nguyên nhân: docker log flood, apt cache, /tmp."

      - alert: DiskRootHighCrit
        expr: 'service:host-disk-monitor AND source_stream:host-cron-probe _time:15m | stats by (mount) max(used_pct) as value | filter value > 88'
        for: 0s
        labels:
          severity: critical
          category: capacity
        annotations:
          summary: "Root partition {{ $labels.mount }} > 88% CRITICAL"
          description: "/ đang {{ $value }}% — sắp vỡ. `du -sh /var/lib/docker/containers/*/ | sort -h | tail`."

      - alert: DiskProbeStale
        expr: 'service:logserver-disk-monitor OR service:host-disk-monitor _time:20m | stats by (service) count() as value | filter value < 3'
        for: 1m
        labels:
          severity: warning
          category: monitoring
        annotations:
          summary: "Disk probe {{ $labels.service }} stale (< 3 events in 20m)"
          description: "Probe {{ $labels.service }} silent — Vector container down hoặc host cron chết. Alert visibility mất."
```

### 6. Validate config trước reload

```bash
cd ~/onelog/infra

# Vector — validate cần chạy trên file mới. Với image alpine không có sẵn binary trên host,
# dùng temp container:
docker run --rm -v $(pwd)/vector/vector.yaml:/etc/vector/vector.yaml:ro \
  -v $(pwd)/vector/probe-logserver-disk.sh:/etc/vector/probe-logserver-disk.sh:ro \
  timberio/vector:0.40.0-alpine vector validate /etc/vector/vector.yaml || \
  { echo "vector validate FAIL"; exit 1; }

# vmalert — dry-run rules (verify binary path trong container trước — thường /vmalert-prod)
docker exec ragstack-vmalert /vmalert-prod \
  -rule=/etc/vmalert/rules.yml -dryRun -datasource.url=http://victorialogs:9428/ 2>&1 | tee /tmp/vmalert-dryrun.log
grep -qi 'error' /tmp/vmalert-dryrun.log && { echo "vmalert rule validation FAIL"; exit 1; }
```

**HARD GATE**: fail 1 trong 2 → STOP, revert file, không apply.

### 7. Apply Vector + vmalert

```bash
# Recreate vector (cần bind mount mới)
docker compose up -d --force-recreate vector
# ~5-10s downtime UDP syslog (acknowledged, không phải SIGHUP thật sự).

# vmalert reload rules
docker compose --profile alerts restart vmalert

# Verify container up
docker compose ps vector vmalert   # State=running
```

### 8. Cài host cron cho `probe-host-disk-root.sh`

```bash
sudo cp ~/onelog/infra/scripts/probe-host-disk-root.sh /usr/local/bin/onelog-probe-host-disk.sh
sudo chmod +x /usr/local/bin/onelog-probe-host-disk.sh

# Add crontab (user vietnt — không cần sudo cho df /)
(crontab -l 2>/dev/null; echo "*/5 * * * * VL_ENDPOINT=http://127.0.0.1:9428/insert/jsonline /usr/local/bin/onelog-probe-host-disk.sh >> /var/log/onelog-host-probe.log 2>&1") | crontab -

# Verify entry
crontab -l | grep onelog-probe-host-disk
```

### 9. Verify probe emit (5-6 phút sau)

```bash
# Vector probe (data disk)
curl -s "http://127.0.0.1:9428/select/logsql/query" \
  --data-urlencode 'query=service:logserver-disk-monitor AND source_stream:vector-exec-probe _time:10m | limit 5' | jq .

# Host cron probe (root)
curl -s "http://127.0.0.1:9428/select/logsql/query" \
  --data-urlencode 'query=service:host-disk-monitor AND source_stream:host-cron-probe _time:10m | limit 5' | jq .

# Kỳ vọng cả 2: ≥ 1 event với used_pct numeric.
```

### 10. Verify vmalert loaded rules

```bash
curl -s http://127.0.0.1:8880/api/v1/rules | \
  jq '.data.groups[] | select(.name=="disk-alerts") | .rules[] | {alert, state}'
# Kỳ vọng: 5 rules, state=inactive (baseline không vượt threshold)
```

### 11. Force-test alert (primary: lower threshold — RECOMMENDED)

```bash
# Backup rules.yml current
cp infra/vmalert/rules.yml infra/vmalert/rules.yml.pretest

# Tạm hạ threshold DiskDataHighWarn xuống > 1 để trigger từ baseline
sed -i.bak 's/filter value > 75/filter value > 1/' infra/vmalert/rules.yml
# LƯU Ý: chỉ 1 rule đầu. Verify diff nhỏ:
diff infra/vmalert/rules.yml.pretest infra/vmalert/rules.yml

docker compose --profile alerts restart vmalert
# Chờ 20 phút (15m for + 5m interval)
# Verify Telegram nhận DiskDataHighWarn

# Restore
cp infra/vmalert/rules.yml.pretest infra/vmalert/rules.yml
rm infra/vmalert/rules.yml.bak
docker compose --profile alerts restart vmalert
# Chờ 5 phút → alert resolve
```

**Fallback nếu muốn test physical disk fill** (chỉ khi lower-threshold không được):
```bash
# CHỈ trên staging hoặc ngoài giờ, KHÔNG 200 GB — dùng 5 GB đủ để đo pipeline
sudo fallocate -l 5G /opt/ragstack/data/_alert_test.bin
# Ngay lập tức set timer cleanup để tránh quên:
sudo nohup sh -c 'sleep 1800 && rm -f /opt/ragstack/data/_alert_test.bin' &
# 5 GB không thay đổi % đủ để trigger warning@75 — cần dd nhiều hơn nếu baseline thấp.
# Recommend: dùng lower-threshold cách primary.
```

## Todo list

- [ ] Tạo probe-logserver-disk.sh (Vector container probe)
- [ ] Tạo probe-host-disk-root.sh (host cron probe)
- [ ] chmod +x cả 2
- [ ] Standalone test 2 probes → JSON valid + VL receive OK
- [ ] Sửa docker-compose.yml vector volumes (bind narrow /opt/ragstack/data)
- [ ] Sửa vector.yaml (source + transform + extend sink `victorialogs`)
- [ ] Grep source_stream — chỉ set 1 chỗ, strip ở transform khác nếu cần
- [ ] Sửa vmalert/rules.yml — append group disk-alerts (5 rules)
- [ ] Validate vector config qua temp container
- [ ] Validate vmalert rules qua `-dryRun`
- [ ] `docker compose up -d --force-recreate vector`
- [ ] `docker compose --profile alerts restart vmalert`
- [ ] Cài host cron
- [ ] Verify Vector probe emit (LogsQL query)
- [ ] Verify host cron probe emit (LogsQL query)
- [ ] Verify vmalert /api/v1/rules load 5 rules
- [ ] Force-test alert bằng lower threshold → Telegram nhận
- [ ] Restore threshold, verify alert resolve

## Success criteria

- Sau 6 phút: LogsQL `service:logserver-disk-monitor` return ≥ 1 event/mount.
- Sau 6 phút: LogsQL `service:host-disk-monitor` return ≥ 1 event.
- vmalert `/api/v1/rules` show 5 rules (DiskDataHighWarn/Crit, DiskRootHighWarn/Crit, DiskProbeStale), state=inactive.
- Force test: transition inactive → pending → firing → Telegram → resolve.
- Container Vector stay Up sau recreate (không restart-loop).

## Rollback

```bash
# Docker-compose + Vector configs
git checkout HEAD -- infra/vector/vector.yaml infra/vmalert/rules.yml infra/docker-compose.yml
rm -f infra/vector/probe-logserver-disk.sh infra/scripts/probe-host-disk-root.sh

# Host cron
sudo crontab -l | grep -v 'onelog-probe-host-disk' | sudo crontab -
sudo rm -f /usr/local/bin/onelog-probe-host-disk.sh /var/log/onelog-host-probe.log

# Recreate services
cd ~/onelog/infra
docker compose --profile agent --profile indexer --profile alerts \
  --profile llm --profile chat --profile dashboard up -d --force-recreate vector
docker compose --profile alerts restart vmalert

# Verify group disk-alerts đã removed
curl -s http://127.0.0.1:8880/api/v1/rules | jq '.data.groups[] | .name' | grep -q disk-alerts && \
  echo "ROLLBACK FAIL — group still loaded" || echo "rollback OK"
```

## Risks (post red-team)

| Risk | Mitigation |
|---|---|
| Bind mount /opt/ragstack/data không thấy submount | `rslave` propagation + standalone test bước 2b verify trước apply |
| LogsQL syntax lỗi → group parse-error | `-dryRun` HARD gate bước 6 |
| Vector container mất ~10s UDP log khi recreate | Acknowledged. rsyslog client queue on-disk 500 MB tolerate được. |
| Log injection từ container khác forge service tag | `source_stream:` field set trong Vector remap, filter trong LogsQL rule. Attacker phải forge cả 2. |
| Host cron fail silent | `DiskProbeStale` rule fire nếu < 3 event/20m. |
| Force test dd fill = vỡ chính stack | Primary = lower threshold, không đụng disk. Fallback 5GB có auto-cleanup timer. |

## Security notes

- **Bind narrow**: chỉ `/opt/ragstack/data:/host/data:ro,rslave`. Không expose `.env`, `/root/.ssh`, docker config. Vector RCE **không thể** dump secrets qua bind này.
- docker.sock vẫn giữ (`docker_logs` source cần) — issue tồn tại độc lập plan này, note trong audit report cho future refactor (docker-socket-proxy).
- Host cron chạy user `vietnt` (không sudo). curl `127.0.0.1:9428/insert` chỉ localhost, không expose network.
- source_stream marker: strip khỏi mọi source Vector khác nếu grep tìm thấy conflict.

## Next steps

→ Phase 03: docs + mockup sync.
