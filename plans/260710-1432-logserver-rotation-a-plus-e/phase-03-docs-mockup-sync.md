# Phase 03 — Docs + mockup sync

## Context

- Plan: [plan.md](plan.md)
- Prereq: Phase 01 + 02 completed

## Overview

**Priority**: MEDIUM (không blocking prod, nhưng bắt buộc trước khi mark plan complete)
**Status**: pending
**Effort**: ~15 phút

Ghi nhận A + E vào documentation để ops team biết cách vận hành và ops mới onboard hiểu strategy.

## Requirements

**Functional**:
- Mockup `onelog-client-deploy-config.html` có section mới "Rotation strategy" + trigger table cho B/C/D deferred.
- `docs/deployment-guide.md` phần "Sau khi deploy" thêm 2 verify step: docker log rotate + disk alert.
- Không đụng nội dung khác.

## Files to modify

- `mockups/onelog-client-deploy-config.html` — thêm section rotation strategy vào cạnh section "Cấu hình VPS production" (đã có từ trước, section `#ls-hardware`).
- `docs/deployment-guide.md` — extend phần cuối "Verify post-deploy".

## Implementation steps

### 1. Mockup — thêm section "Log rotation strategy" sau `#ls-hardware`

Vị trí: sau block `<section class="card p-5 lane lane-app" id="ls-hardware">...</section>` (kết thúc "Log Server — Cấu hình VPS production"), thêm section mới cùng lane `lane-app`.

Nội dung cần cover:

**Card 1: 4-tầng rotation hiện tại**
| Tầng | Cơ chế | Config |
|---|---|---|
| VictoriaLogs | ZSTD auto-prune | `VL_RETENTION=7d` |
| NATS JetStream | max_age 3d | code hardcode indexer/nats_consumer.py |
| Docker container log | json-file 10m×3 | `/etc/docker/daemon.json` (host, phase 01) |
| Backup snapshot | KEEP_DAYS=7 | scripts/snapshot-daily.sh |

**Card 2: Disk alert thresholds**
| Alert | Threshold | Severity | Action |
|---|---|---|---|
| DiskDataHigh | `/opt/ragstack/data` > 75% | warning | Giảm `VL_RETENTION` hoặc thêm ổ |
| DiskRootHigh | `/` > 80% | critical | Docker log flood — check `du -sh /var/lib/docker/containers/*/` |

**Card 3: Deferred fixes + trigger to unlock**
| Fix | Trigger để làm |
|---|---|
| B. NATS max_bytes | `nats stream info LOGS` messages > 5M hoặc bytes > 20 GB |
| C. VL retention dynamic | `vl_data_size_bytes / vl_data_max_bytes > 0.8` fire |
| D. Backup tách VL | Archive > 300 GB / snapshot |

**Card 4: Scale reference (từ brainstorm)**
Bảng compression: 10/100/500/1000 clients → stored/day → 7d / 30d retention size.

### 2. Docs `deployment-guide.md` — thêm 2 verify step

Tìm section "Verify post-deploy" hoặc tương đương gần cuối file. Append:

```markdown
### Verify docker log rotate (host-level)

```bash
# Verify daemon config
cat /etc/docker/daemon.json | jq '.["log-opts"]'
# Expect: {"max-size": "10m", "max-file": "3"}

# Verify per-container applied
for c in $(docker compose ps -q); do
  docker inspect --format '{{.Name}} → {{.HostConfig.LogConfig.Config}}' $c
done
# Expect: mỗi container có max-size:10m
```

Nếu container chưa có config (do chạy trước khi apply daemon.json), recreate:
`docker compose up -d --force-recreate <service>`

### Verify disk alerts

```bash
# vmalert loaded rules
curl -s http://127.0.0.1:8880/api/v1/rules | \
  jq '.data.groups[] | select(.name=="disk-alerts") | .rules[] | {alert, state}'

# Expect: DiskDataHigh + DiskRootHigh, state=inactive (baseline)
```

Force-test alert (chạy trên staging trước khi tin trên prod):
- Fill disk artificial: `dd if=/dev/zero of=/opt/ragstack/data/_test.bin bs=1M count=200000`
- Wait 20 phút → verify Telegram nhận DiskDataHigh
- Cleanup: `rm /opt/ragstack/data/_test.bin`
```

### 3. Verify HTML parse + không phá layout

```bash
python -c "from html.parser import HTMLParser; \
  HTMLParser().feed(open('mockups/onelog-client-deploy-config.html',encoding='utf-8').read()); \
  print('html OK')"
```

### 4. TOC update mockup

Thêm entry `<li><a href="#ls-rotation">Rotation strategy</a></li>` vào TOC group Log Server, ngay sau `Cấu hình VPS`.

## Todo list

- [ ] Locate insert point sau section `#ls-hardware` trong mockup
- [ ] Viết 4 card mới (rotation tầng / thresholds / triggers / scale reference)
- [ ] Add `id="ls-rotation"` cho anchor
- [ ] Add TOC entry
- [ ] HTML parse validation
- [ ] Locate section "Verify post-deploy" trong deployment-guide.md
- [ ] Append 2 verify block (docker log rotate + disk alerts)
- [ ] Preview mockup trong browser — layout ok, không overflow

## Success criteria

- Mở mockup trong browser → click TOC "Rotation strategy" → scroll đến section mới, layout không tràn.
- `docs/deployment-guide.md` diff chỉ append cuối, không sửa content cũ.
- Ops mới clone repo → đọc README → deployment-guide → biết cần verify docker log rotate + disk alert.

## Rollback

```bash
git checkout HEAD -- mockups/onelog-client-deploy-config.html docs/deployment-guide.md
```

## Risks

| Risk | Mitigation |
|---|---|
| Mockup layout tràn khung khi thêm nhiều card | Dùng `.grid grid-cols-2` (như section VPS specs). Đã fix `.grid > *{min-width:0}` từ trước. |
| Docs quá dài | Chỉ append 2 block ~30 dòng. Không rewrite section cũ. |
| Vietnamese/English mix | Deployment-guide đã Vietnamese → giữ nhất quán. |

## Next steps

→ Mark plan status `completed` sau khi phase 03 done + verify tất cả success criteria.
→ Journal entry ghi decision skip B/C/D và tiêu chí unlock.
