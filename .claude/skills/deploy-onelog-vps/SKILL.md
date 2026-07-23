---
name: deploy-onelog-vps
description: "One-shot deploy pipeline cho OneLog: commit local changes (nếu có) → push origin/master → SSH onelog-vps → git reset --hard origin/master → auto-detect service nào bị đụng → restart/force-recreate → verify. Activate khi user nói: 'deploy vps', 'deploy lên vps', 'ship vps', 'sync vps', 'đồng bộ vps', 'push lên vps', 'triển khai lên vps'."
metadata:
  author: vietnt
  version: "1.0.0"
---

# Deploy OneLog VPS — One-Shot Sync + Restart

Đóng gói pipeline `local → github → onelog-vps` thành 1 workflow duy nhất. Guarantee VPS `git status` clean sau mỗi lần chạy (per VPS↔local sync memory rule).

## When to run

- **Manual triggers**: `deploy vps`, `deploy lên vps`, `ship vps`, `sync vps`, `đồng bộ vps`, `push lên vps`, `triển khai lên vps`, `deploy onelog`.
- **Post-cook**: sau khi `/ck:cook` hoàn tất phase edit code + user muốn deploy ngay.
- **Post-edit**: user vừa edit file infra/* và muốn thấy hiệu ứng trên VPS.

## Non-goals

- KHÔNG deploy client fleet (rsyslog forwarder). Đó là job của `infra/scripts/deploy-client.sh` / Ansible playbook — skill này CHỈ deploy log-server VPS.
- KHÔNG chạm `.env` file trên VPS (secrets). Nếu user thay đổi env logic cần yêu cầu SSH sửa `.env` bằng tay TRƯỚC khi chạy skill này.

## Pipeline (mandatory order)

```
1. Pre-check local     → git status, git branch, uncommitted diff summary
2. Commit if dirty     → conventional commit msg auto-drafted từ diff
3. Push origin/master  → git push (fail-fast nếu behind remote hoặc conflict)
4. VPS sync            → ssh onelog-vps "git fetch && git reset --hard origin/master"
5. Detect services     → map changed files → docker compose targets (bảng dưới)
6. Restart/recreate    → theo restart-strategy per service
7. Verify              → docker ps, container health, container logs no-error
8. Report              → 1-block summary với commit hash + services + verify status
```

## Path → Service mapping

Sử dụng `git diff --name-only <old>..<new>` để lấy files bị đụng, đối chiếu bảng:

| Path pattern | Service (docker compose) | Restart strategy |
|---|---|---|
| `infra/vmalert/rules.yml`, `infra/vmalert/*.yml` (log LogsQL) | `vmalert` | `docker compose restart vmalert` (**KHÔNG dùng HTTP /-/reload** — endpoint refuse) |
| `infra/vmalert/metric-rules.yml` (Prometheus rules) | `vmalert-metrics` | `docker compose restart vmalert-metrics` |
| `infra/alertmanager/alertmanager.yml` | `alertmanager` | `docker compose up -d --force-recreate alertmanager` (**bắt buộc** vì sed entrypoint render `/tmp/alertmanager.yml`) |
| `infra/vector/vector.yaml` hoặc `infra/vector/probe-*.sh` | `vector` | `docker compose restart vector` |
| `infra/caddy/Caddyfile` | `caddy` | `docker exec ragstack-caddy caddy reload --config /etc/caddy/Caddyfile 2>&1 \|\| docker compose restart caddy` |
| `infra/litellm/config.yaml` | `litellm-proxy` | `docker compose restart litellm-proxy` |
| `infra/mcp-vl/*`, `infra/mcp-semantic/*` | `mcp-vl`, `mcp-semantic` | `docker compose restart <matched>` |
| `infra/mcpo/config.template.json` | `mcpo` | `docker compose up -d --force-recreate mcpo` (sed entrypoint) |
| `infra/openwebui/*` | `openwebui` | `docker compose restart openwebui` |
| `infra/docker-compose.yml` | full stack | `docker compose up -d` (Compose apply diffs) |
| `infra/scripts/*.sh` mà host cron gọi (probe-host-disk-root.sh, snapshot-daily.sh, ...) | host, không phải container | Copy file: `ssh onelog-vps "cp /opt/onelog/infra/scripts/<name>.sh /usr/local/bin/onelog-<name>"` |
| `docs/**`, `README.md`, `mockups/**`, `plans/**` | none | Skip restart |
| `infra/.env.example` | none | Skip. Nhắc user nếu key mới cần vào `.env` thật trên VPS |

**Nếu file không match pattern nào**: fail-safe = báo user, không restart bừa.

## Guardrails

Kiểm tra trước khi thao tác — nếu vi phạm, STOP và ask user:

1. **Local branch ≠ `master`**: hỏi user có chắc muốn deploy từ branch khác không.
2. **Local có untracked/modified file nhạy cảm** (`.env`, `*.key`, `*.pem`, `credentials.json`): fail, không auto-add.
3. **Remote master ahead of local**: hỏi pull rebase trước khi push.
4. **VPS `git status` dirty** trước khi reset --hard: report file list, hỏi user (có thể là edit tay chưa commit — memory rule yêu cầu VPS luôn clean, nếu dirty đó là dấu hiệu drift).
5. **Commit message trống hoặc quá generic** khi auto-draft: nếu diff phức tạp (>3 files khác chức năng), ask user duyệt msg.

## Auto-draft commit message

Từ `git diff --stat` + `git diff` scope:
- 1 file only → `<type>(<scope>): <one-line>` (VD: `fix(alertmanager): repeat_interval 2h→4h`)
- Nhiều file cùng scope → `<type>(<scope>): <umbrella>` + bullet body
- Cross-scope → user duyệt

Type detection:
- File touched ở `docs/`, `README.md` → `docs`
- Rules threshold thay đổi số → `fix` hoặc `feat`
- Thêm rule/receiver/route mới → `feat`
- Rename / cleanup → `refactor`
- Env schema mở rộng → `feat` (env-example) hoặc `chore` (comment only)

## Verify block (post-restart)

```bash
# 1. Container up
ssh onelog-vps "docker ps --filter name=ragstack- --format 'table {{.Names}}\t{{.Status}}' | grep -E '$(echo <touched_services> | tr ' ' '|')'"

# 2. Recent error logs (5m gần đây)
ssh onelog-vps "for s in <touched_services>; do echo === \$s ===; docker logs --since 5m ragstack-\$s 2>&1 | grep -Ei 'error|panic|fatal' | head -5; done"

# 3. Service-specific verify (nếu applicable):
#    - vmalert: curl /api/v1/rules count > 0
#    - alertmanager: curl /api/v2/status .config.original không có "null" placeholder
#    - vector: docker exec ragstack-vector vector validate /etc/vector/vector.yaml
```

## Report format (1 block, tối giản)

```
Deploy summary
──────────────
Commit:    <hash> <subject>
Files:     <N> changed
Services:  <list>
VPS HEAD:  <hash> (clean)
Verify:    ✅ all up  |  ⚠ <details>
```

## Failure handling

- **Push fail (rejected, non-fast-forward)**: STOP, ask user pull rebase or force decision.
- **SSH fail**: STOP, hỏi user check network/ssh config (`~/.ssh/config` alias `onelog-vps`).
- **Docker compose restart fail**: keep git state as-is (đã push, VPS đã reset), show container logs 20 lines cuối, ask user.
- **Verify fail (container không up)**: report container + logs, KHÔNG auto-rollback (destructive) — hỏi user muốn `git revert` local + redeploy.

## Rollback recipe (nếu cần, user opt-in)

```bash
git revert HEAD && git push origin master
ssh onelog-vps "cd /opt/onelog && git fetch && git reset --hard origin/master"
# rerun skill với touched services từ commit vừa revert
```

## What NOT to do

- KHÔNG force push.
- KHÔNG `docker compose down` (state loss cho VL/Qdrant/OpenWebUI).
- KHÔNG dùng `--no-verify` bypass pre-commit hook.
- KHÔNG restart `victorialogs`, `victoriametrics`, `qdrant`, `postgres`, `openwebui` khi user chỉ chạm rules/alertmanager (data services không cần touch cho alert change).
- KHÔNG chạy `docker system prune` / `volume rm` — không phải job của skill này.
- KHÔNG modify `.env` trên VPS. Nếu deploy cần env key mới, STOP và hướng dẫn user SSH sửa bằng tay.

## Example transcripts

**User**: `deploy vps`

Skill flow:
1. `git status` → 2 files modified: `infra/vmalert/rules.yml`, `infra/alertmanager/alertmanager.yml`
2. Diff analysis → `fix(alerts): threshold tune + inhibit rule cleanup`
3. Commit + push
4. `ssh onelog-vps` reset --hard
5. Detect: rules.yml → vmalert; alertmanager.yml → alertmanager
6. `docker compose restart vmalert` + `docker compose up -d --force-recreate alertmanager`
7. Verify: both containers `Up 15s`, no error log
8. Report

**User**: `deploy vps` (nothing to commit)

Skill:
- Skip commit step
- Verify local == origin (pull if behind)
- If VPS behind: sync
- If nothing to deploy: report "already in sync, HEAD=<hash>"

**User**: `deploy vps` với vector.yaml + rules.yml đụng cả 2

Skill: restart vmalert + vector song song (independent), verify từng cái.

## Extension hooks (future)

- `deploy vps --dry-run`: chỉ show mapping + commands, không thao tác.
- `deploy vps --only <service>`: skip auto-detect, restart cưỡng bức 1 service.
- `deploy vps --observe <min>`: sau restart, tail logs `min` phút để catch late errors.

Không implement mặc định — YAGNI. Add khi có nhu cầu thực.
