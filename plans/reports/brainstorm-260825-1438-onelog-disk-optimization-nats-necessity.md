---
title: OneLog disk optimization state + NATS necessity analysis
slug: onelog-disk-optimization-nats-necessity
date: 2026-08-25
type: brainstorm
status: agreed
host: onelog-vps (prod)
followup_to:
  - plans/260825-1334-onelog-nats-tune-defer-1tb (completed)
  - plans/260825-1412-vector-severity-reclassify-nats-flood-fix (completed)
next_action: create plan A — Ansible client rsyslog rollout
---

# OneLog disk optimization + NATS necessity analysis

## Problem statement

Sau 2 fix consecutive (NATS compression + Vector reclassify), user hỏi:
1. Đã tối ưu disk tối đa chưa?
2. Bỏ NATS được không? Bắt buộc giữ không?

## Current state (14:38, T+16min post-Vector-fix)

| Metric | Value | Note |
|---|---|---|
| NATS ingest | 334 msg/s | (was 5400 baseline) — 94% drop |
| NATS storage | 37.4 GB | old blocks uncompressed, will decline post-72h |
| Consumer pending | 22.09M | dropping 3.2k/s ack rate; ETA ~2h clear |
| Disk `/` | 69G/100G | will settle ~45-50G post-72h |
| Indexer ack rate | 3.2k msg/s | HEALTHY — was ingest-bound, not process-bound |
| VL storage | 1.2 GB | 30d retention active |
| Vector reclassify | active | 78% marker hit + fallback null→info |

## Findings

### 1. Optimization ceiling

**Đã tối ưu:**
- ✅ VL columnar+zstd → không nén thêm được
- ✅ Vector severity reclassify → NATS ingest 94% drop
- ✅ NATS compression s2 → new blocks compressed
- ✅ VL retention 30d confirmed

**Còn dư địa (~20-30%):**
- NATS `max_age 72h → 24h`: save 65% (10G → 3.5G). Trade replay window.
- Purge NATS old uncompressed blocks: immediate ~15-20GB recovery.
- Docker container log limits audit: uniform `max-size:100m,max-file:3`.
- Qdrant retention policy: currently NO TTL — templates grow forever.
- OpenWebUI SQLite retention: 918MB growing.
- Plan A (Ansible client rollout): fix root cause client-side.

### 2. NATS necessity analysis

**NATS role in OneLog:**
```
Vector → NATS logs.warn (72h buffer) → Indexer → Drain3 → Qdrant → mcp-semantic → OpenWebUI (via MCP tool)
```

**Key evidence:** OpenWebUI at http://10.200.0.30/ IS consuming mcp-semantic → Indexer + Qdrant → có value thực. Cannot delete AI pipeline.

**Bắt buộc giữ NATS?** KHÔNG technically:
- VL = single source of truth cho all log data
- Alternatives:
  - **Option 1: Indexer poll VL API** — replace NATS entirely
  - **Option 2: Vector HTTP push → Indexer** — no buffer, limited replay
  - **Option 3: Delete AI pipeline** — ❌ ruled out (OpenWebUI consumer active)
  - **Option 4: Keep NATS as-is** — post-tune ~10GB acceptable

**Verdict:** Giữ NATS hiện tại (pragmatic). Consider Option 1 later khi rảnh (architectural cleanup, save 10GB + 1 service).

## Prioritized roadmap

### Priority 1 (immediate, this session): Plan A creation
**Ansible rsyslog client rollout** cho 70 host (50 shipped + 20 sắp ship):
- Fix root cause: client sends everything as `priority=warning` → correct per-app priority mapping
- Post-A: 95% logs classified đúng ở SOURCE → Vector reclassify redundant
- Revert `reclassify_severity` sau A stable → Vector config clean

### Priority 2 (this week): Monitor + optional purge
- t+6h: pending <5M
- t+24h: pending <1M, disk starts declining
- Decision gate: purge NATS blocks nếu disk >55G at t+24h

### Priority 3 (1-3 months, optional): Architectural cleanup
- Option 1 (Indexer poll VL) — bỏ NATS entirely
- Docker log limits audit (uniform)
- Qdrant TTL policy design

## Plan A design brief

**Scope:**
- 70 host (Nethost, TurboHost, TurboWeb, OneHost) sending log về onelog-vps
- Fix rsyslog omfwd config: preserve internal app priority thay vì force priority=warning
- Cover apps: LiteSpeed (`[NOTICE]/[INFO]/[error]`), MySQL (`[Warning]`), Apache/ModSecurity, LSPHP, systemd, kernel

**Approach:**
1. **Audit phase:** SSH sample 3-5 host mỗi loại (nethost/turbohost/turboweb/onehost) → identify current rsyslog config
2. **Design phase:** rsyslog config template với `$AppSeverity` extraction or `$msg` regex-based re-priority
3. **Lab test:** apply cho 1 host → verify VL severity distribution before/after
4. **Rollout phase:** batch 5 host → 20 host → all 70
5. **Validate phase:** VL query per-batch, monitor NATS ingest rate
6. **Cleanup phase:** revert Vector `reclassify_severity` transform → git commit

**Rollback:** Ansible has backup file per host, can restore via playbook revert.

**Estimated effort:** 1-2 tuần (1 week design + lab, 1 week rollout).

## Success metrics

**Plan A goals:**
- 95% logs correctly classified at source (VL severity distribution matches reality)
- NATS ingest without Vector reclassify: <600 msg/s (real WARN+)
- Vector config simplified (revert reclassify_severity block)
- Zero data loss during rollout
- All 70 host on standard rsyslog config

## Risks

| Risk | Mitigation |
|---|---|
| App-specific priority mapping complex (LiteSpeed has 10+ log levels) | Start with common patterns; edge cases fall to default=warning (safe) |
| rsyslog config break log forward | Backup + Ansible rollout batched with verify step |
| 70 host reboots need scheduling | rsyslog restart không cần host reboot; SIGHUP works |
| Sample host insufficient for pattern coverage | Sample 5 host per group before design lock |
| Vector reclassify still needed cho edge cases | Keep as fallback until Plan A 100% coverage confirmed |

## Unresolved (resolve during Plan A phase 1)
1. Exact rsyslog config method: `omfwd` template vs `programname`-based rule?
2. Which client OS distributions? (assume Debian/Ubuntu — verify)
3. Ansible inventory hiện đã có 70 host chưa? (`infra/ansible/`)
4. Rollout batch size / cadence agreed với ops team?
5. Downtime tolerance per host (rsyslog restart ~1s, negligible)
