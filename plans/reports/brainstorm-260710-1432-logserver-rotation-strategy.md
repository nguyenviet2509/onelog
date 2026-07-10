---
title: OneLog LogServer — retention & rotation strategy trước prod
date: 2026-07-10 14:32 UTC+7
scope: quyết định fix set A-E trước deploy prod 10-500 clients
outcome: execute A + E; defer B/C/D
---

# LogServer rotation strategy — prod-scale

## Vấn đề

Deploy OneLog prod với hàng chục → hàng trăm client server forward log về 1 LogServer VPS (8 vCPU / 31 GB / 905 GB data). Câu hỏi: cơ chế rotation hiện tại có đảm bảo không tràn disk không? Fix set A-E (đề xuất ở audit) có cần execute toàn bộ?

## Realities

### VictoriaLogs compression
ZSTD columnar → 10x-40x nén cho log text. Real-world:

| Scale | Raw/day | Stored/day | 7d | 30d |
|---|---|---|---|---|
| 10 clients | 2 GB | ~80 MB | 560 MB | 2.4 GB |
| 100 clients | 20 GB | ~800 MB | 5.6 GB | 24 GB |
| 500 clients | 100 GB | ~4 GB | 28 GB | 120 GB |
| 1000 clients | 200 GB | ~8 GB | 56 GB | 240 GB |

→ **905 GB thừa sức chứa 1000 clients @ 30d.** VL không phải nguồn rủi ro chính.

### Rủi ro thật sự — ranked

1. 🔴 **Docker container logs → `/` partition (98 GB)**: 11/14 services chưa config logging → dùng Docker default (unbounded). Container spam stdout = OS crash. **Compression VL không cứu.**
2. 🔴 **Không có disk alert**: vỡ disk = surprise. Cần alert @ 75-80%.
3. 🟡 Backup archive: 7 daily × ~5-30 GB (VL đã nén) = 35-200 GB. Chưa vấn đề với 905 GB.
4. 🟢 NATS unbounded: chỉ vấn đề nếu indexer down >1 tuần liên tục. YAGNI.
5. 🟢 VL retention fixed 7d: compression đã lo, không cần dynamic.

## Options evaluated

### Option 1: Full A-E (defensive-in-depth)
- Pros: Cover mọi edge case. An tâm.
- Cons: ~1-2h work. B/C/D chưa có evidence cần. Violate YAGNI.

### Option 2: A + E only ✅ CHỌN
- Pros: 15 phút work. Cover 90% rủi ro thật (docker log flood + disk visibility).
- Cons: B/C/D làm reactive khi vấp.

### Option 3: Skip all
- Pros: Deploy nhanh.
- Cons: Docker log unbounded = time bomb trên `/` partition. Không chấp nhận.

## Decision

**Execute A + E trước prod.** Defer B/C/D. Setup trigger để biết khi nào làm B/C/D.

### A. Docker log rotate — host-level

`/etc/docker/daemon.json` (tạo mới hoặc merge):
```json
{
  "log-driver": "json-file",
  "log-opts": {"max-size": "10m", "max-file": "3"}
}
```
Apply: `sudo systemctl restart docker` (dừng stack ~1 phút, `docker compose up -d` lại).

Effect: mọi container tự rotate ở host level, không cần đụng compose.yml. 30 MB/container × 14 containers = 420 MB max — an toàn trên `/` 98 GB.

### E. Disk usage alerts — vmalert

Thêm vào `infra/vmalert/rules.yml`:
```yaml
- alert: DiskDataHigh
  expr: (node_filesystem_size_bytes{mountpoint="/opt/ragstack/data"} 
         - node_filesystem_avail_bytes{mountpoint="/opt/ragstack/data"}) 
        / node_filesystem_size_bytes{mountpoint="/opt/ragstack/data"} > 0.75
  for: 15m
  labels: {severity: warning}

- alert: DiskRootHigh
  expr: (node_filesystem_size_bytes{mountpoint="/"} 
         - node_filesystem_avail_bytes{mountpoint="/"}) 
        / node_filesystem_size_bytes{mountpoint="/"} > 0.80
  for: 15m
  labels: {severity: critical}
```
> ⚠️ Cần node_exporter running trên host (chưa có trong stack — check nếu thiếu, thêm vào compose hoặc dùng vmagent scrape /proc).

## Triggers cho B/C/D sau này

| Fix | Trigger — thấy dấu hiệu này mới làm |
|---|---|
| **B. NATS max_bytes** | `nats stream info LOGS` → `messages` > 5M hoặc `bytes` > 20 GB |
| **C. VL retention giảm** | Rule `vl_data_size_bytes / vl_data_max_bytes > 0.8` fire (đã plan) |
| **D. Backup tách VL** | Backup archive > 300 GB / snapshot |

## Client-side safety net (đã có sẵn)

- rsyslog client: `queue on-disk 500 MB` → LogServer down <1-2 ngày không mất log.
- Vector: buffer config trong `vector.yaml` (verify trước prod).

## Success metrics

- After A: `du -sh /var/lib/docker/containers/*` mỗi container < 40 MB steady state.
- After E: Telegram alert khi disk > 75%/80%. Response < 24h → giảm retention hoặc thêm ổ.
- 3 tháng post-deploy: disk usage curve linear, no surprise spike, no `/` crash.

## Next steps

1. Execute A + E (15 phút, low-risk).
2. Update mockups `onelog-client-deploy-config.html` — thêm section rotation strategy + trigger table.
3. Note trong `docs/deployment-guide.md` phần "Sau khi deploy" → verify Docker log rotate applied.

## Unresolved

- node_exporter chưa có trong stack — verify: có metric endpoint nào scrape được disk usage không? Nếu không, phải thêm node_exporter service (5 phút) hoặc dùng Vector exec source poll `df`.
- VL cluster mode để scale > 1000 clients: đã plan trong `docs/ha-roadmap.md` — không phải bây giờ.
- Log spike burst khi 100 clients cùng reboot: Vector default buffer đủ chưa? Cần load test hoặc trust rsyslog client queue.
