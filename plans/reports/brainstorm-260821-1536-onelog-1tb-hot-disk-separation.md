---
type: brainstorm
date: 2026-08-21
slug: onelog-1tb-hot-disk-separation
env: onelog-vps (prod)
approach: Option B — Selective HOT-only
status: approved, plan pending
---

# OneLog 1TB HOT-Disk Separation — Brainstorm

## Problem
Prod VPS `onelog-vps` hiện chạy 100GB single disk (sda2, 32% used). Cần mount 1TB riêng cho log storage để:
- Có room scale retention 7d → 30d
- Isolate blast radius: disk log fail không kéo theo TLS cert/CA/audit
- Chuẩn bị scale từ 3 servers → 100+ servers

## State đo được (2026-08-21)

```
/dev/sda2 100G, used 32G (32%)  ← current

/opt/onelog/infra/data breakdown:
  victorialogs   641 MB   ← HOT
  qdrant         159 MB   ← HOT
  nats            2.4 GB  ← HOT
  victoriametrics 153 MB  ← HOT (metrics warm)
  vector           0 B    ← HOT (buffer)
  --- total HOT: ~3.4 GB
  grafana        224 MB   ← STATE
  audit          4.4 MB   ← STATE
  indexer        196 KB   ← STATE
  alertmanager     4 KB   ← STATE
  openwebui      903 MB   ← APP data
```

VL_RETENTION hiện tại = 7d. Sẽ tăng lên 30d.

## Approaches đã evaluate

| Option | Mô tả | Verdict |
|---|---|---|
| **A** | Mount toàn bộ `./data/` lên 1TB | Rejected — cert + CA + audit chung disk log, blast radius rộng |
| **B** | Selective: chỉ VL/Qdrant/NATS/VM/Vector | **✅ Chosen** — blast radius tách bạch, config đơn giản |
| **C** | Full: data + /var/lib/docker | Rejected — overkill cho MVP (~15k events/ngày), phức tạp cutover |

## Chosen: Option B — Selective HOT

### Target layout

```
/dev/sda2 (100GB, system)                    /dev/sdb1 (1TB, XFS, HOT)
├── /opt/onelog/infra/                       └── /opt/onelog/data-hot/
│   ├── docker-compose.yml                       ├── victorialogs/
│   ├── .env  (VL_RETENTION=30d)                 ├── qdrant/
│   └── data/                                    ├── nats/
│       ├── grafana/         (STATE)             ├── victoriametrics/
│       ├── audit/           (STATE)             └── vector/
│       ├── indexer/         (STATE)
│       ├── alertmanager/    (STATE)
│       ├── openwebui/       (APP)
│       ├── caddy/           (TLS)
│       └── step-ca/         (CA)
└── /var/lib/docker/  (stays on sda2)
```

### 5 bind path changes trong `docker-compose.yml`

| Service | Old | New |
|---|---|---|
| victorialogs | `./data/victorialogs` | `/opt/onelog/data-hot/victorialogs` |
| qdrant | `./data/qdrant` | `/opt/onelog/data-hot/qdrant` |
| nats | `./data/nats` | `/opt/onelog/data-hot/nats` |
| victoriametrics | `./data/victoriametrics` | `/opt/onelog/data-hot/victoriametrics` |
| vector | `./data/vector` | `/opt/onelog/data-hot/vector` |

Vector line 93 (`/opt/onelog/infra/data:/host/onelog-data:ro,rslave`) — **không đổi**. `rslave` tự thấy nested mount.

### Filesystem + mount opts

- **XFS** (chọn thay ext4 vì VL sequential large writes + fsync heavy → +15–20% throughput)
- Mount opts: `defaults,noatime,nodiratime`
- Persist via `/etc/fstab` bằng UUID (không dùng device name)

## Runbook overview (chi tiết trong plan phases)

**Prep (không downtime):**
1. Partition + mkfs.xfs /dev/sdb1
2. fstab entry + mount /opt/onelog/data-hot
3. Verify docker exec để lấy UID/GID thật từng container
4. Grep snapshot-daily.sh xem có hardcode path cũ không

**Cutover (~5–10 min downtime):**
5. `docker compose stop victorialogs qdrant nats victoriametrics vector`
6. rsync 5 dirs → data-hot (~30s cho 3.4GB)
7. chown đúng UID
8. Edit compose (5 paths) + .env (VL_RETENTION=30d)
9. `docker compose up -d`
10. Verify VL query, NATS stream, Qdrant collection
11. Rename source dirs .bak (safety)

**Post-cutover:**
12. Commit về local repo → push origin/master → git reset --hard trên VPS (per VPS sync policy)
13. Update docs/deployment-guide.md
14. Update snapshot-daily.sh nếu cần
15. 24h sau, xóa .bak dirs

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Rsync miss file khi VL đang flush | Data loss | Bắt buộc `docker compose stop` trước rsync |
| Sai UID/GID sau chown | Container không ghi được (silent fail) | Verify UID động: `docker exec <svc> id` trước cutover |
| VL OOM với 30d retention | Service crash loop | Set `--storage.minFreeDiskSpaceBytes=100GB`, monitor RSS 24h |
| Disk sdb1 fail | Mất 30d data mới | Git revert compose → dùng lại data 7d cũ (chưa xóa .bak) |
| Snapshot script hardcode path cũ | Backup rỗng | Check `snapshot-daily.sh` trước cutover, update sync |

## Scale ceiling (1TB @ 30d hot)

| Profile | Daily volume | 30d storage (10x compression) | 1TB usage |
|---|---|---|---|
| MVP hiện tại | ~15k events/ngày | ~15 GB | 1.5% |
| 100 servers | ~100 GB/ngày | ~300 GB | 30% |
| 500 servers | ~500 GB/ngày | ~1.5 TB | **>100% — cần cold tier** |

Ngưỡng cần thêm S3/MinIO cold tier: **>150 GB/ngày** (~50% disk sau 30d, room cho spike).

## Success criteria

- [ ] `df -h /opt/onelog/data-hot` shows 1TB XFS mounted
- [ ] `docker compose ps` — 5 HOT services running healthy
- [ ] VL query `curl -s localhost:9428/select/logsql/query -d 'query=*&limit=1'` returns data
- [ ] Retention 30d confirmed: VL flag `--retentionPeriod=30d`
- [ ] Git status clean local + prod, docs updated
- [ ] Snapshot cron 02:00 tomorrow succeeds với path mới
- [ ] 24h ổn định, RSS VL < 4GB, no OOM

## Unresolved (verify trong plan Phase 1)

1. UID/GID exact từng container — assume VL=1000, Grafana=472, phải exec verify
2. `snapshot-daily.sh` có hardcode `data/victorialogs` không → cần grep
3. Disk /dev/sdb đã gắn vật lý chưa? Nếu chưa → provider ticket trước
4. VL heap/RSS baseline hiện tại để so sánh sau khi tăng retention
