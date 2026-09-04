# Brainstorm — GitOps cho OneLog client forwarder rollout

**Date:** 2026-08-17
**Slug:** forwarder-gitops
**Status:** Approved → next `/ck:plan`

## Problem statement

Hiện tại member VHKT triển khai forward log về OneLog theo **1 trong 2 cách**:
1. Manual copy template rsyslog từ trang KB `kb.inet.vn/books/tai-lieu-huong-dan-su-dung-cong-cu-ho-tro-vhkt/page/cau-hinh-forward-log-server-ve-cong-cu-luu-log-tap-trung-onelog` → paste vào host
2. Ansible với template do central cấp

**Pain points:**
- Template update → không có kênh notify member → toàn fleet drift, không đồng bộ
- Host mới → member self-service thủ công → dễ miss step
- Không track được host nào đang chạy version nào
- Không rollback được centralized

**Ràng buộc quan trọng:**
- Fleet **decentralized**: mỗi member sở hữu host riêng, central không có SSH key vào hosts đó
- Central chỉ publish template (KB) — model push-based Ansible từ central không khả thi
- Host trong DC nội bộ INET (LAN reach)
- Có GitLab self-host + Runner sẵn
- Member có sudo/root nhất quán
- Scope hẹp: chỉ rsyslog forward, 6-12 tháng không extend

## Approaches evaluated

| Hướng | Cơ chế | Verdict |
|---|---|---|
| **A. Ansible + CI push** | CI runner SSH push xuống fleet | ❌ Không khả thi — central không có key vào host member |
| **B. Ansible-pull cron** | Host chạy `ansible-pull` timer | ⚠️ Over-engineer — cần Python + Ansible runtime 200MB cho 1 conf file |
| **C. Bash + git + systemd** ⭐ | Host chạy `apply.sh` từ systemd timer, tự pull git repo | ✅ **CHỌN** — KISS, fit scope |
| **D. Config server + curl** | Host `curl` conf từ HTTP endpoint centralize | ⚠️ Mất PR review flow, thêm service |
| **E. Salt/Puppet master** | Agent-based centralized | ❌ Over-engineer với 1 conf file |

## Final solution — "onelog-forwarder-agent"

### Kiến trúc

```
GitLab self-host (INET)                Host member (n hosts trong LAN)
┌──────────────────────────┐          ┌─────────────────────────────┐
│ onelog-forwarder/ repo   │          │ /opt/onelog-forwarder/      │
│                          │◄─────────┤   git pull (Deploy Token)   │
│  templates/*.conf.tmpl   │  15 phút │   apply.sh reconciler       │
│  bin/{apply,bootstrap}.sh│          │                             │
│  systemd/*.{service,timer}│         │ systemd timer: onelog-      │
│  vars/default.env        │          │   forwarder.timer           │
│  VERSION                 │          │                             │
│  .gitlab-ci.yml          │          │ Render → rsyslogd -N1 →     │
│  ┌────────────────────┐  │          │   diff → reload rsyslog     │
│  │ GitLab Runner (CI) │  │          │                             │
│  │ - Validate template│  │          │ /etc/rsyslog.d/             │
│  │ - Shellcheck bin/  │  │          │   90-forward-onelog.conf    │
│  │ - Tag release      │  │          │                             │
│  └────────────────────┘  │          └─────────────────────────────┘
└──────────────────────────┘
```

### Component roles

| Component | Nhiệm vụ |
|---|---|
| **GitLab repo** | Source of truth: template + script + VERSION |
| **GitLab Runner** | CI: validate rsyslog template (rsyslogd -N1), shellcheck bin/, tag release khi merge main. **Không push xuống host.** |
| **systemd timer** trên host | Lịch reconcile mỗi 15 phút |
| **apply.sh** trên host | Reconciler idempotent: pull → check VERSION → render → validate → apply |
| **bootstrap.sh** (1 lần khi onboard) | Cài systemd unit, clone repo, chạy apply lần đầu |

### Repo layout

```
onelog-forwarder/
├── .gitlab-ci.yml                          # CI validate + tag
├── templates/
│   └── rsyslog-90-forward-onelog.conf.tmpl # envsubst template
├── vars/
│   └── default.env                         # LOG_SERVER_IP, PORT
├── bin/
│   ├── apply.sh                            # reconciler
│   └── bootstrap.sh                        # onboard installer
├── systemd/
│   ├── onelog-forwarder.service            # Type=oneshot
│   └── onelog-forwarder.timer              # OnCalendar=*:0/15
├── VERSION                                 # bump khi template thay đổi
└── README.md                               # link về KB
```

### Auth model — Deploy Token read-only

- Tạo 1 Deploy Token per-repo (read-only, `read_repository` scope)
- Embed vào git URL: `https://onelog-deploy:<token>@gitlab.inet.vn/onelog/forwarder.git`
- Token đặt trong `bootstrap.sh` — member dán token khi onboard, hoặc bootstrap fetch token từ endpoint nội bộ
- Revoke được từ GitLab UI nếu leak

### apply.sh reconciler flow (idempotent)

```
1. git -C /opt/onelog-forwarder pull --ff-only
2. NEW=$(cat VERSION); OLD=$(cat /var/lib/onelog-forwarder/last-applied 2>/dev/null || echo "")
3. [ "$NEW" = "$OLD" ] && exit 0    # noop nếu chưa đổi version
4. Render: envsubst < template > /tmp/preview.conf
   env sources: vars/default.env + /etc/onelog-forwarder/host.env (local overrides)
5. rsyslogd -N1 -f /tmp/preview.conf → nếu fail: log ERROR, giữ conf cũ, exit 1
6. diff /tmp/preview.conf /etc/rsyslog.d/90-forward-onelog.conf
   nếu khác: backup .bak, thay conf, systemctl reload rsyslog
7. echo "$NEW $(sha256sum) $(date -Iseconds)" > /var/lib/onelog-forwarder/last-applied
8. journalctl log kết quả
```

### `.gitlab-ci.yml` skeleton

```yaml
stages: [validate, test, release]

validate-template:
  stage: validate
  image: ubuntu:22.04
  script:
    - apt-get update && apt-get install -y rsyslog gettext-base
    - source vars/default.env && envsubst < templates/rsyslog-90-forward-onelog.conf.tmpl > /tmp/out.conf
    - rsyslogd -N1 -f /tmp/out.conf

lint-scripts:
  stage: validate
  image: koalaman/shellcheck-alpine
  script: [shellcheck bin/*.sh]

test-bootstrap:
  stage: test
  image: ubuntu:22.04
  script: [bash bin/bootstrap.sh --dry-run]

tag-release:
  stage: release
  only: [main]
  script:
    - V=$(cat VERSION)
    - git tag "v$V" && git push origin "v$V"
```

### Onboard host mới (workflow member)

```bash
# 1 lệnh, member chạy trên host
curl -fsSL https://gitlab.inet.vn/onelog/forwarder/-/raw/main/bin/bootstrap.sh \
  | sudo bash -s -- --token <deploy-token>

# hoặc: bootstrap tự fetch token từ endpoint nội bộ (nếu triển)
```

Bootstrap thực hiện:
1. Kiểm tra prereq (systemd, rsyslog, git installed)
2. Clone repo về `/opt/onelog-forwarder` (dùng token)
3. Copy systemd unit + timer vào `/etc/systemd/system/`
4. `systemctl daemon-reload && enable --now onelog-forwarder.timer`
5. Chạy `apply.sh` lần đầu ngay (không chờ 15 phút)
6. Verify: `logger -t onelog-selftest` + `journalctl -u onelog-forwarder --since -1m`

### Template update workflow (central)

1. Anh sửa `templates/*.tmpl`, bump `VERSION`, MR vào GitLab
2. Runner tự chạy CI validate → nếu đỏ, không merge được
3. Merge main → Runner tag release
4. Trong ≤15 phút, tất cả host tự pick up + apply
5. Rollback = `git revert` + push → host tự revert

### Host-specific overrides

- `/etc/onelog-forwarder/host.env` (local, không tracked ở repo)
- VD: `SERVICE_TAG=payment-api`, `EXTRA_FILTER=xxx`
- Reconciler đọc và merge với `vars/default.env`

## Trade-offs & Risk

### Pros
- KISS thật: bash + git + systemd, không runtime nặng
- Debug dễ: `journalctl -u onelog-forwarder`
- Rollback centralized = 1 commit
- Onboard host mới = 1 lệnh
- CI validate ngăn shoot-yourself-in-foot
- Drift auto-heal (ai sửa conf tay bị revert sau 15 phút)
- Extend Phase 2 dễ: thêm canary channel, heartbeat, dashboard fleet inventory

### Risks & Mitigate

| Rủi ro | Mitigate |
|---|---|
| Template broken → toàn fleet die trong 15 phút | (a) GitLab CI `rsyslogd -N1` validate — reject MR sai syntax; (b) apply.sh cũng validate trước khi drop; (c) Phase 2 thêm canary channel |
| GitLab xuống | apply.sh fail-safe: conf hiện tại giữ nguyên, chỉ dừng update. Không panic. |
| Deploy token leak | Token read-only, revoke từ UI. Log commit token vào git là mistake — dùng `.gitignore` cho `token` file, chỉ embed lúc bootstrap. |
| Host offline lâu (>1 tuần) | Reconciler idempotent — pull nhiều commit, apply state cuối. Safe. |
| Ai đó SSH sửa conf tay | 15 phút sau bị revert (drift heal — điểm mạnh, không phải bug) |
| Member không muốn timer chạy tự động | Cho phép `systemctl stop onelog-forwarder.timer` để pause; nhưng warning: sẽ drift |

## Migration path

- Member đang chạy conf cũ (copy từ KB): chạy `bootstrap.sh` → tự backup conf hiện tại `.bak` → thay bằng conf render từ template
- Incremental, không cần cutover 1 lượt
- Trang KB `kb.inet.vn/.../cau-hinh-forward-log-server-ve-cong-cu-luu-log-tap-trung-onelog` cần **rewrite**: bỏ hướng dẫn manual, thay bằng "chạy 1 lệnh `curl | bash`"

## Phase decomposition

**Phase 1 (MVP):**
1. Tạo repo `onelog-forwarder` trên GitLab self-host
2. Viết `templates/rsyslog-90-forward-onelog.conf.tmpl` (adapt từ conf hiện tại)
3. Viết `bin/apply.sh` + `bin/bootstrap.sh`
4. Viết `systemd/*.{service,timer}`
5. Viết `.gitlab-ci.yml` cho validate + tag
6. Test trên `onelog-source` lab (throw-away host)
7. Test trên 1 prod host thật (canary manual)
8. Update KB page kb.inet.vn — hướng dẫn 1 lệnh

**Phase 2 (nếu cần, chưa scope):**
- Canary channel (branch `canary` cho 5-10 host trước)
- Heartbeat: apply.sh POST `{host, version, hash, ts}` về OneLog endpoint
- Dashboard "Fleet inventory": host nào version nào, last-seen
- Alert khi có host drift > 24h

## Success metrics

- **Adoption**: 100% host member migrate sang bootstrap flow trong 30 ngày
- **Update lag**: template update → 95% fleet apply trong 30 phút
- **Drift rate**: 0 host chạy conf custom sau khi migrate (query VL check schema đồng nhất)
- **Onboard time**: từ 15 phút (manual) xuống ≤2 phút (bootstrap)
- **Rollback time**: ≤30 phút toàn fleet (2 chu kỳ timer)

## Next steps

1. `/ck:plan` — sinh implementation plan chi tiết theo phase decomposition trên
2. Confirm Deploy Token flow với team GitLab admin (cần quyền tạo token)
3. Chuẩn bị lab host `onelog-source` cho E2E test

## Unresolved

- **Bootstrap token distribution**: member dán token thủ công khi chạy `curl | bash`, hay có endpoint nội bộ để bootstrap fetch tự động? (Endpoint nội bộ cần build thêm, Phase 1 dùng manual dán token.)
- **KB page rewrite**: ai owner trang KB, quy trình update?
- **`.gitignore` OneLog repo hiện tại**: có cần thêm entry `onelog-forwarder/` để junction / test folder không bị commit nhầm? (Verify khi setup repo mới.)
- **Version bump**: manual bump `VERSION` file mỗi PR, hay Runner auto-bump theo semver? Phase 1 manual, Phase 2 automate nếu cần.
- **Multi-distro support**: template hiện tại chỉ test trên Ubuntu 22.04. Có host CentOS/Rocky/Debian khác không? Nếu có, bootstrap.sh cần detect distro để cài rsyslog đúng cách.
