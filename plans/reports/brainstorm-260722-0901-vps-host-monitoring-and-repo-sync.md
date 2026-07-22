# Brainstorm — VPS Host Monitoring + Repo Sync

**Date:** 2026-07-22 09:01 Asia/Saigon
**Author:** brainstorm skill
**Status:** Approved by user
**Related:** deploy session 2026-07-21 (VPS 10.200.0.30)

## Problem

Sau khi deploy full OneLog lên VPS, còn 2 gap:

1. **Không monitor host-level metrics** (CPU, RAM, network throughput, disk I/O). Chỉ có container `/metrics` (indexer, VL, qdrant, litellm, vmalert). Khi VPS bị nghẽn network / CPU spike / RAM leak — không detect được.
2. **Repo local drift so với VPS**: 5-6 divergences (Caddy openwebui route, Grafana subpath override, dashboard metric names, scrape.yml Qdrant key, systemd unit profiles) chưa được sync về `master`. Nếu redeploy fresh sẽ mất fix.

## Approaches evaluated

| # | Approach | Verdict |
|---|---|---|
| A | `node_exporter` container (host CPU/RAM/net/disk) | **CHOSEN** — industry standard, 1 container, KISS |
| B | node_exporter + cAdvisor (host + per-container) | Defer — YAGNI cho lab; bật khi cần debug perf |
| C | Chỉ network throughput | Rejected — node_exporter cover cả CPU/RAM free |
| D | Vector `host_metrics` source ship to VL | Rejected — metrics as logs, không integrate với existing VM+Grafana |

## Chosen design

### Host collector

- `prom/node-exporter:v1.8.2` (pinned version)
- `network_mode: host` + `pid: host` — thấy interface + PID thật
- Bind `127.0.0.1:9101` — không đụng indexer `:9100`
- Command: `--path.procfs=/host/proc`, `--path.sysfs=/host/sys`, filter mount points

### Scrape

- Job `onelog-host` → `host.docker.internal:9101` (Docker ≥ 20.10 với `host-gateway`)
- VM container thêm `extra_hosts: ["host.docker.internal:host-gateway"]`

### Dashboards

**a. `onelog-vps-host.json` (mới)** — 6-8 panels: CPU % stacked, load avg, memory used/cached/free, swap, network rx/tx per interface, disk I/O + usage per mount.

**b. Extend `onelog-pipeline-health.json`** — thêm 1 row sparkline: host CPU, RAM used %, network rx+tx. Drill-down link → dashboard (a).

### Secret pattern

- `scrape.yml.example` (tracked, có `%{QDRANT_API_KEY}` placeholder)
- `scrape.yml` (rendered, gitignored)
- `infra/scripts/render-scrape.sh` — 3 dòng envsubst

Lý do: bump VM version chỉ vì 1 flag = scope creep + risk. envsubst nhất quán với `.env.example` pattern có sẵn.

### Repo sync — 6 commits độc lập, KHÔNG push

Branch: `feat/vps-monitoring-and-sync` từ `master`.

1. `fix(caddy): mount OpenWebUI at root for IP-based deploy`
2. `feat(grafana): support subpath deploy via docker-compose.override`
3. `fix(grafana/dashboards): correct indexer + qdrant metric names`
4. `feat(monitoring): add node_exporter for host metrics`
5. `fix(scrape): use *.example pattern for Qdrant Bearer templating`
6. `docs: update deployment-guide with monitoring + prod-fixes notes`

Không commit: `.env`, `.env.llm`, rendered `scrape.yml`, `docker-compose.override.yml`, `data/*`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `network_mode: host` giảm isolation | Code trusted, chỉ read-only mount |
| Node Exporter Full (1860) 500 panels quá nặng | Custom subset 6-8 panels, không import raw |
| Local repo uncommitted `mockups/onelog-production-deploy.html` | Skip khỏi branch mới |
| Redeploy fresh mất `scrape.yml` (gitignored) | `render-scrape.sh` chạy trước `docker compose up` — check trong deployment-guide |

## Success metrics

- `node-exporter` container healthy
- `up{job="onelog-host"} == 1` trên VM
- `node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`, `node_network_receive_bytes_total` có data
- Dashboard "OneLog VPS host" 6-8 panels đầy đủ
- 6 commit sạch trên branch, chưa push
- Repo local + VPS đồng bộ sau khi user merge master

## Implementation order

1. Verify VPS Docker version + scrape.yml current state
2. Local branch off master
3. Commit 1-6 theo thứ tự (mỗi commit self-contained, test được độc lập)
4. Pull code trên VPS + `render-scrape.sh` + `docker compose --profile monitoring up -d node-exporter`
5. Verify dashboards data
6. Report commit hashes + push instructions

## Unresolved (deferred)

1. **VM retention** — giữ default 30d
2. **Host alert rules** (CPU > 80%, disk > 85%) — defer sang phase sau, không nằm trong scope này
3. **Push branch** — Claude commit local, user review + push khi sẵn sàng
4. **cAdvisor** — bật khi team cần debug perf per-container
