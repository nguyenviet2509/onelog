# Phase 01 — Docker host log rotate

## Context

- Plan: [plan.md](plan.md)
- Related: audit report line 42 "Docker log rotate global config"
- Post red-team + validate: sequence bổ sung `systemctl stop ragstack` trước restart docker; jq deep merge; `dockerd --validate`.

## Overview

**Priority**: HIGH (blocking prod deploy)
**Status**: pending
**Effort**: ~15 phút (5 phút edit + 2 phút stop stack + 1-2 phút restart docker + 3-5 phút recreate + verify)

Set Docker daemon default log rotation cho **mọi container** ở host level. Áp dụng 1 lần → 14 container tự động có rotation khi recreate.

## Key insights (post red-team)

- 11/14 service không khai báo `logging:` block → Docker default (unbounded json-file).
- Sau apply: `max-file:3` = 3 rotated + 1 active = 4 files × 10 MB = **40 MB/container**. 14 container × 40 MB + per-service overrides (litellm max-file:5 = 60 MB) ≈ **~620 MB max total** trên `/`. Vẫn an toàn với `/` 98 GB.
- `ragstack.service` (`Requires=docker.service`) cascade khi restart docker → phải explicit stop/start ragstack, không dựa systemd tự handle.

## Files to modify

**Trên host logserver-01** (KHÔNG trong repo):
- `/etc/docker/daemon.json` — tạo mới hoặc **deep-merge** nếu đã có.

**Trong repo** (documentation cover ở phase 03).

## Pre-flight

```bash
# 1. Verify snapshot cron không đang chạy
pgrep -f snapshot-daily && echo "ABORT: snapshot in progress" || echo "OK snapshot idle"

# 2. Verify time không rơi vào 02:00-02:30 (snapshot cron window)
date +%H:%M
# Nếu trong window → chờ.

# 3. Backup daemon.json hiện tại
sudo cp /etc/docker/daemon.json /etc/docker/daemon.json.bak 2>/dev/null || echo "no existing config"
sudo cat /etc/docker/daemon.json 2>/dev/null || echo "no daemon.json yet"
```

## Implementation steps

### 1. Ghi/merge `/etc/docker/daemon.json` (deep merge)

Nếu chưa có → tạo mới:
```bash
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
```

Nếu đã có → **deep merge** (không dùng `. + {}` shallow merge sẽ overwrite `log-opts`):
```bash
sudo apt-get install -y jq   # nếu chưa có

sudo jq '
  .["log-driver"] //= "json-file" |
  .["log-opts"] = ((."log-opts" // {}) + {"max-size":"10m","max-file":"3"})
' /etc/docker/daemon.json.bak | sudo tee /etc/docker/daemon.json
```

### 2. Pre-flight validate config

```bash
# a. JSON syntax
sudo jq -e '.["log-driver"] == "json-file" and .["log-opts"]["max-size"] == "10m"' \
  /etc/docker/daemon.json || { echo "config verify FAIL"; exit 1; }

# b. Docker daemon dry-run validate (Docker 20.10+)
sudo dockerd --validate --config-file /etc/docker/daemon.json && echo "daemon config valid"

# c. Diff review — thấy chính xác gì thay đổi
diff <(sudo jq -S . /etc/docker/daemon.json.bak 2>/dev/null || echo '{}') \
     <(sudo jq -S . /etc/docker/daemon.json)
```

**HARD GATE**: nếu bất cứ bước validate nào fail → STOP, restore backup, không restart daemon.

### 3. Stop ragstack (không để systemd cascade)

```bash
sudo systemctl stop ragstack     # ExecStop = docker compose down (clean, giữ volumes)
# Verify tất cả container down
docker compose ps  # should be empty
```

### 4. Restart docker daemon với auto-rollback safety

```bash
sudo systemctl restart docker

# Wait & verify daemon active
sleep 5
if ! sudo systemctl is-active --quiet docker; then
  echo "docker daemon fail to start — auto-rollback"
  sudo cp /etc/docker/daemon.json.bak /etc/docker/daemon.json 2>/dev/null || \
    sudo rm /etc/docker/daemon.json
  sudo systemctl restart docker
  sudo systemctl start ragstack
  exit 2
fi

echo "docker daemon OK"
```

### 5. Start ragstack + recreate containers với profile đầy đủ

```bash
sudo systemctl start ragstack   # ExecStart = docker compose up -d (default profile only)

# Recreate với FULL profile list để container mới nhận config log rotate.
# SUDO cần thiết: compose parse toàn stack — litellm-proxy dùng
# env_file `.env.llm` chmod 0400 root → không sudo = permission denied.
cd ~/onelog/infra
sudo docker compose --profile agent --profile indexer --profile alerts \
  --profile llm --profile chat --profile dashboard up -d --force-recreate
```

⚠️ Note discrepancy: `ragstack.service ExecStart` chỉ chạy default profile. Muốn full stack post-restart, ops phải chạy `sudo docker compose --profile ... up -d --force-recreate` explicit. Có kế hoạch reconcile systemd unit sau (out of scope phase này).

⚠️ Sqlite-web (profile `[dbtools]`) không recreate vì không trong profile list default → giữ log-config cũ (unbounded). Nếu ops enable dbtools sau này, chạy `sudo docker compose --profile dbtools up -d --force-recreate sqlite-web` để apply rotate.

### 6. Verify từng container có log config đúng

```bash
for c in $(docker compose ps -q); do
  name=$(docker inspect --format '{{.Name}}' $c)
  cfg=$(docker inspect --format '{{.HostConfig.LogConfig.Config}}' $c)
  echo "$name → $cfg"
done
```

Kỳ vọng: **mọi container** show `map[max-file:3 max-size:10m]` (trừ 3 service per-service override: `litellm-proxy` = max-file:5, `openwebui`/`grafana` = max-file:3 vẫn khớp).

Nếu container nào thiếu config → do `--force-recreate` không apply → recreate riêng:
```bash
sudo docker compose up -d --force-recreate <service>
```

## Todo list

- [ ] Pre-flight: `pgrep snapshot-daily` empty, ngoài 02:00-02:30 window
- [ ] Backup `/etc/docker/daemon.json.bak`
- [ ] Ghi config mới (deep merge nếu có sẵn)
- [ ] Validate JSON + `dockerd --validate` + diff review
- [ ] `systemctl stop ragstack`
- [ ] `systemctl restart docker` với auto-rollback wrapper
- [ ] `systemctl start ragstack`
- [ ] `docker compose ... up -d --force-recreate` full profile
- [ ] Verify tất cả container có `max-size:10m max-file:3`
- [ ] Ghi note vào ops changelog

## Success criteria

- `sudo jq . /etc/docker/daemon.json` show `log-driver:json-file` + `log-opts` đúng.
- 14/14 container `docker inspect` show `max-size:10m` + `max-file:3-5`.
- `du -sh /var/lib/docker/containers/*/` sau 7 ngày → không container > 40 MB (60 MB cho litellm override).
- Không service nào crash / behavior đổi sau recreate.
- Systemd `systemctl status ragstack` = active.

## Rollback

```bash
sudo systemctl stop ragstack
sudo cp /etc/docker/daemon.json.bak /etc/docker/daemon.json 2>/dev/null || sudo rm /etc/docker/daemon.json
sudo systemctl restart docker
sudo systemctl start ragstack

cd ~/onelog/infra
sudo docker compose --profile agent --profile indexer --profile alerts \
  --profile llm --profile chat --profile dashboard up -d --force-recreate

# Verify state matches pre-plan
for c in $(docker compose ps -q); do
  docker inspect --format '{{.Name}} → {{.HostConfig.LogConfig.Config}}' $c
done
```

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Docker daemon fail start | Low | `dockerd --validate` pre-flight + auto-rollback wrapper step 4 |
| Snapshot cron race | Low | Pre-flight check + window exclusion |
| Systemd Requires cascade race | N/A | Explicit `stop ragstack` trước |
| Container mất log lịch sử >30 MB | Expected | Backup log qua `docker cp` trước nếu cần archive |
| Full stack downtime ~1-3 phút | Accepted | Chạy ngoài giờ cao điểm |

## Security notes

Không thay đổi permission / user context. `/etc/docker/daemon.json` chỉ ảnh hưởng logging driver. Không expose port mới.

## Next steps

→ Phase 02: Vector probe + host cron probe + vmalert disk rules.
