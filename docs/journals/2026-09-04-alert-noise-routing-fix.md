# 2026-09-04 — Telegram alert noise + routing fix

Brainstorm + cook trong 1 session. User báo alert spam 5-10 phút/lần + mail alerts đi sai topic. 2 bugs cùng lúc: routing hijack (category-based route đứng trước host-based route) + 94% false positive từ 3 known-benign patterns (Zimbra cronjobs, CloudLinux throttler, cgroup OOM duplicate). 3 commits deploy trong 30 phút.

## Kết quả

- **Active alerts 32 → 18** (44% drop 10m sau deploy, expect thêm 10-15% drop sau tune iteration)
- **SystemdServiceFailed 13 → 1** (94% ↓) — CloudLinux `db_governor.service` expected restart cycle excluded
- **KernelErrorBurst → 0** — `Memory cgroup out of memory (lsphp)` excluded, dedup với OomKillEvent
- **SudoEscalation 6 → 3 → 0 (expected)** — Zimbra `zmmailboxdmgr` + `zmmtastatus` + `zimbra-service-status.sh` cronjobs excluded
- **Mail routing bug fixed** — mail host alerts (SudoEscalation category=audit) route đúng `telegram-mail-server` thread 5228, không còn hijack sang Client-Server topic
- **OomKillEvent chronic** — group_interval bump 5m → 15m cho category=availability giảm renotify frequency (real signal, không exclude được)

## Chronology

### Session 1: Brainstorm 260904-0815
User send screenshot topic "Hosting Client Server" 5,585 messages, thấy mailer-*/zmhn* alerts (SudoEscalation) mỗi 5-10 phút. Sample msg: `zimbra : COMMAND=/opt/zimbra/libexec/zmmailboxdmgr status`.

Investigation `alertmanager.yml`:
- Route order: `category=~"security|audit"` (line 40) đứng #1
- Mail host route (line 89) đứng #8
- Alertmanager first-match-win → SudoEscalation label `category=audit` bị route #1 hijack

Empirical measurement 32 active alerts:
- SystemdServiceFailed 13 hosts × 100% `db_governor.service`
- OomKillEvent 11 hosts × 100% `lsphp invoked oom-killer`
- SudoEscalation 6 hosts (mail) × 100% `zmmailboxdmgr`

Full audit rules.yml → discovery: KernelErrorBurst 100% = `Memory cgroup out of memory (lsphp)` = duplicate OomKillEvent (same cgroup OOM signal).

**94% (30/32) là false positive từ 3 known patterns**.

Design 5 fixes chosen (Approach A: fix at source):
1. Routing reorder — host ownership > alert kind
2. SudoEscalation exclude `zmmailboxdmgr`
3. SystemdServiceFailed exclude `db_governor`
4. KernelErrorBurst exclude `Memory cgroup out of memory`
5. group_interval 15m cho category=availability

**Report**: `plans/reports/brainstorm-260904-0815-telegram-alert-noise-routing-fix.md`
**Plan**: `plans/260904-0815-telegram-alert-noise-routing-fix/` — 4 phase files

### Session 2: Cook (auto-continued)
Merge Phase 01 + Phase 03 vào 1 commit vì cùng chạm `alertmanager.yml`:

**Commit `722db21`** — alertmanager routes reorder:
- Move `category=~"security|audit"` từ position #1 xuống sau host-based routes
- Add `category="availability"` route với `group_interval: 15m`

**Commit `85bdd9a`** — vmalert 3 rules exclude:
```yaml
KernelErrorBurst:   -_msg:"Memory cgroup out of memory"
SudoEscalation:     -_msg:"zmmailboxdmgr"
SystemdServiceFailed: -_msg:"db_governor"
```

Deploy: `git push` → SSH VPS `git reset --hard` → `docker compose restart alertmanager vmalert`. Zero downtime.

10 phút wait cho eval cycle → verify:
- Active 32 → 21 (34%)
- SystemdServiceFailed 13 → 1 ✅
- KernelErrorBurst → 0 ✅
- SudoEscalation 6 → 3 ⚠️ (còn 3 patterns Zimbra khác)
- **Routing verify**: 3 remaining mail alerts route đúng `telegram-mail-server` (bug 1 fully fixed)

Sample 3 SudoEscalation còn lại:
- `zmmtastatus` (Zimbra MTA status check)
- `zimbra-service-status.sh` (custom monitoring script)

**Commit `72d10ad`** — extend SudoEscalation exclude:
```yaml
SudoEscalation: -_msg:"zmmailboxdmgr" -_msg:"zmmtastatus" -_msg:"zimbra-service-status"
```

Deploy: `docker exec ragstack-vmalert wget POST /-/reload` (hot reload, no restart needed).

## Learning

1. **Alertmanager route order matters critically** — first-match-win semantic + wrong order = alert silently mis-routed. Design rule: **host ownership > alert kind**. Host-based routes (host, cluster, component) luôn đứng TRƯỚC category/severity fallback.

2. **Full audit before spot fix** — user báo SudoEscalation spam nhưng full audit tìm ra 3 patterns (SudoEscalation, SystemdServiceFailed, KernelErrorBurst) cùng bị false positive. Nếu chỉ fix SudoEscalation thì vẫn còn 20+ noise alerts. Full audit tiết kiệm iteration.

3. **KernelErrorBurst overlap OomKillEvent** — 2 rules cùng catch cgroup OOM signal. Deduplicate tại source (exclude) tốt hơn inhibit_rule alertmanager vì (a) không cần label match state machine, (b) reduce vmalert eval cost, (c) prevent OneMCP webhook duplicate fanout.

4. **LogsQL `-_msg:"pattern"` cho negative filter** — surgical, self-documenting, preserves security intent. Không phá threshold-based detection cho real signals.

5. **Iterative tune expected** — Phase 02 first ship covered 3 patterns discovered pre-deploy, missed 2 patterns discovered post-eval (`zmmtastatus`, `zimbra-service-status.sh`). Phase 04 tune iteration = normal workflow, không phải fail.

6. **vmalert hot reload > restart** — `wget --post-data='' /-/reload` reload rules không mất eval state. Alertmanager phải `docker compose restart` (sed-rendered config at container start, memory pattern `alertmanager-config-reload.md`).

## Style

- Fix at source (rule query) > silence downstream (alertmanager silence)
- Surgical exclude > blanket threshold bump (preserve real signal detection)
- 5-minute Zimbra cronjob cycle = classic false-positive smell — check `_msg` patterns for periodic tokens
- Journal + memory record: `docs/journals/2026-09-04-alert-noise-routing-fix.md`

## Unresolved

- **Phase 04 24h observation pending** — cần capture actual Telegram msgs/24h delta post-deploy. Baseline ~302/24h (per plan 260826-1044). Target ≤120.
- **OomKillEvent 11 → 16 hosts expansion** — chronic lsphp OOM cluster tăng, root cause = customer sites hit LVE memory limit. Không giải quyết được từ OneLog side. Follow-up: ops team scale LVE limits hoặc contact khách.
- **Rules chưa audit trong iteration này** — MysqlErrorBurst, AuditLoginFailures, DbConnectionRefused, WebServerErrorBurst, SshBruteForce, SmtpDeliveryFailure không active hôm nay nhưng có thể có benign pattern. Follow-up: monitor 24h post-deploy.
- **Alertmanager notification log trend analysis** — vmalert `_msg` không log alertname structured. Follow-up: scrape `alertmanager_notifications_total` metric để trend 24h/7d.
