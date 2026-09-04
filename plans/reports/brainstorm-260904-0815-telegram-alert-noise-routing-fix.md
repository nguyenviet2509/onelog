# Brainstorm — Telegram alert noise + routing fix

**Ngày**: 2026-09-04 08:15 (+07) · **Trigger**: user báo alert spam 5-10 phút/lần trong topic Hosting Client Server + mail-server alerts đi sai topic.

## Problem statement

**Bug 1 — Wrong topic routing**: Alerts từ mail hosts (`mailer-*`, `zmhn*`) đang đi vào topic Hosting Client Server thay vì Mail-Server topic (thread 5228). Ảnh minh họa: 5,585 messages trong Hosting Client Server, top event từ mailer-0104/mailer-0304/mailer-0404/zmhn022606/zmhn072505/zmhn092403.

**Bug 2 — Spam 5-10 phút cùng 1 alert**: SudoEscalation fire mỗi 5-10 phút cho cùng mail host trong 24h+ liên tục. Sample `_msg`: `zimbra : COMMAND=/opt/zimbra/libexec/zmmailboxdmgr status` — Zimbra internal cronjob.

## Empirical measurement

Snapshot 32 active alerts (2026-09-04 08:20 +07):

| Alertname | Count | Root cause | Signal |
|---|---|---|---|
| **SystemdServiceFailed** | 13 hosts | 100% `db_governor.service Failed with result 'exit-code'` — CloudLinux MySQL throttler expected restart | ❌ False positive |
| **OomKillEvent** | 11 hosts | 100% `lsphp invoked oom-killer` — customer PHP hit LVE memory limit | ✅ Real (chronic) |
| **SudoEscalation** | 6 hosts (mail) | 100% Zimbra `zmmailboxdmgr status` cronjob | ❌ False positive |
| QdrantTemplateGrowthHigh | 1 | log_templates collection growth | ✅ Real |
| SmtpDeliveryFailure | 1 | Mail delivery real event | ✅ Real |

**94% (30/32) là false positive từ 2 known-benign patterns**.

Kernel err top pattern (1h sample): 1,200+ events = `Memory cgroup out of memory: Killed process (lsphp)` = **overlap OomKillEvent** (cùng cgroup OOM signal, KernelErrorBurst threshold >7 → fire duplicate).

## Routing bug analysis

`alertmanager.yml` route order (top-to-bottom, first-match-win):
```
Route #1: category=~"security|audit"  → telegram-client-server  ← SudoEscalation match ở đây
...
Route #8: host=~"mailer-*|zmhn*"      → telegram-mail-server    ← NEVER MATCHED
```

SudoEscalation label `category=audit` → matcher #1 HIJACK trước matcher mail host (#8). Mail-server alerts đi vào Client-Server topic.

**Rule of thumb violation**: category-based routes đang thắng host-based routes. Should reverse — **host ownership > alert kind**.

## Spam bug analysis

- Rule `SudoEscalation`: `for: 5m`, threshold `>10 sudo COMMAND events`
- Zimbra `zmmailboxdmgr status` = cronjob chạy chu kỳ ~5m
- Mỗi cycle: sudo count spike → cross threshold → alert fire per host
- Group_by=[alertname, severity, category] → tất cả host trong 1 group
- Group members churn (host fire/resolve theo cronjob cycle) → alertmanager coi là "group changed" → renotify per `group_interval=5m`
- `repeat_interval=2h` cho category=audit **KHÔNG hiệu quả** vì group churn liên tục

Fix false positive tại source → group không churn → resolved permanent → không renotify.

## Approaches evaluated

### Approach A — Fix at source (chosen)
- Reorder alertmanager routes
- Extend vmalert rule queries exclude known-benign patterns
- Tune group_interval cho availability chronic

**Pros**: Surgical, preserve detection real signals, KISS, no rule proliferation.
**Cons**: Cần identify từng benign pattern qua sampling.

### Approach B — Bump thresholds fleet-wide
- SudoEscalation >10 → >100 cho mail hosts
- SystemdServiceFailed >3 → >20

**Pros**: Đơn giản 1 số.
**Cons**: Miss real escalation nếu attacker biết threshold, không giải quyết KernelErrorBurst overlap.

### Approach C — Silence known-benign qua Alertmanager
- Silence permanent per host+pattern

**Pros**: Không đụng rule.
**Cons**: Silence không expire, hard to audit, over-silence risk khi Zimbra process rename.

**Chọn A** — fix tại vmalert query level = surgical, self-documenting, preserves security intent.

## Final design — 5 fixes

### Fix 1: Routing reorder (`infra/alertmanager/alertmanager.yml`)
Move host-based routes ABOVE category-based routes:
```yaml
routes:
  - team=llm-cost → llm-cost topic
  - host=logserver + component=host + cluster=authway|onemcp → log-server topic
  - host=~"mailer-*|zmhn*|mta3|store.mailer" → mail-server topic   # ← MOVED UP (từ #8 lên #4)
  - category=~"security|audit" → client-server (2h)                # ← was #1, giờ sau mail
  - notify_style=event → event
  - severity=critical → client-server (2h)
  - severity=~"critical|warning" → onemcp-webhook (continue=true)
```

### Fix 2: SudoEscalation exclude Zimbra cronjob (`infra/vmalert/rules.yml`)
```yaml
expr: '(service:sudo OR _msg:"sudo:") _msg:"COMMAND="
       -_msg:"zmmailboxdmgr"
       | stats by (host, host_ip) count() as value, row_any(_msg) as sample_msg
       | filter value:>10'
```

### Fix 3: SystemdServiceFailed exclude CL throttler (`infra/vmalert/rules.yml`)
```yaml
expr: '_msg:"Failed with result"
       -_msg:"db_governor"
       | stats by (host, host_ip) count() as value, row_any(_msg) as sample_msg
       | filter value:>3'
```

### Fix 4: KernelErrorBurst dedup với OomKillEvent (`infra/vmalert/rules.yml`)
```yaml
expr: 'service:kernel severity:err
       -_msg:"Memory cgroup out of memory"
       | stats by (host, host_ip) count() as value, row_any(_msg) as sample_msg
       | filter value:>7'
```
Reason: cgroup OOM đã bắt bởi OomKillEvent. KernelErrorBurst nên focus real kernel error (I/O, hardware, oops).

### Fix 5: Bump group_interval availability (`infra/alertmanager/alertmanager.yml`)
Add route sub-matcher trước severity routes:
```yaml
- matchers:
    - category="availability"
  receiver: telegram-client-server        # hoặc keep existing host/event routes
  group_interval: 15m
  repeat_interval: 12h
```
Reason: OomKillEvent chronic 11-host cluster tạo group churn spam. 15m group_interval + compact view >5 hosts = 1 message per 15m thay vì mỗi 5m.

## Implementation considerations

- **Route order sensitive**: alertmanager first-match-win. Any reorder cần verify existing routes not broken. Fix 1 + Fix 5 phải viết cẩn thận không conflict.
- **VRL/LogsQL syntax cho `-_msg`**: negative filter LogsQL uses `-field:value` — verified in existing `rules.yml:118` (`stats by...`) pattern.
- **Backward compat**: Existing legit alerts (real sudo escalation, real db_governor failure hiếm) vẫn fire vì exclude quá surgical (chỉ 1 pattern per rule).
- **Testing**: sau deploy verify:
  1. SudoEscalation không còn fire cho mail hosts (query `alertname=SudoEscalation` in AM)
  2. SystemdServiceFailed không còn fire db_governor
  3. Mail host alert đi ĐÚNG topic 5228 (kiểm tra live alert từ mail host)
  4. Real signals (bump threshold test) vẫn fire

## Risk assessment

| Risk | Impact | Mitigation |
|---|---|---|
| Exclude pattern too broad → miss real signal | Low: pattern rất specific (`zmmailboxdmgr`, `db_governor`, `Memory cgroup out of memory`) | Comment ghi rõ intent + rev if needed |
| Route reorder break existing routes | Medium: log-server topic có thể mất alerts | Kiểm tra dry-run alertmanager config + verify 24h post-deploy |
| Attacker rename sudo command to avoid `zmmailboxdmgr` filter | Very low: attacker cần root already để run sudo, filter chỉ giảm noise không phải security control | Combine với auditd elsewhere |
| Real db_governor bug (không phải throttler restart) bị miss | Low: nếu db_governor thực sự crash → downstream MysqlErrorBurst sẽ fire | Log query VL riêng để investigate |

## Success metrics

Post-deploy 24h:
- **Alert Telegram count/24h**: dự kiến giảm 60-80% (30/32 false positive fix + group churn eliminated)
- **Mail topic (thread 5228)**: nhận đúng mailer/zmhn alerts, không lẫn với hosting
- **Client-Server topic**: chỉ nhận hosting alerts + true audit event (rare)
- **Alertmanager active alerts**: dự kiến giảm 32 → 5-10 (chỉ real signals: OOM cluster, disk, real audit)

## Next steps

1. Chốt approach với user (đã DONE)
2. Tạo plan formal `/ck:plan` với các phase files
3. Cook execute plan
4. Verify 24h + tune iterative
5. Journal

## Unresolved

- **OomKillEvent chronic 11-host cluster** — root cause là customer sites hit LVE memory limit. Không giải quyết được từ OneLog side, chỉ tune notification. Follow-up: report cluster hosts cho ops team để scale LVE limits hoặc contact khách.
- **Rules chưa audit** (SshBruteForce, MysqlErrorBurst, WebServerErrorBurst, DbConnectionRefused, etc.) — không active trong snapshot hiện tại. Follow-up: monitor 24h post-deploy, sample nếu thấy spam mới.
- **Alertmanager historical fire log**: vmalert `_msg` không log alertname structured, hard để trend analysis 24h. Follow-up: enable alertmanager notification_log parsing hoặc scrape `alertmanager_notifications_total` metric.
