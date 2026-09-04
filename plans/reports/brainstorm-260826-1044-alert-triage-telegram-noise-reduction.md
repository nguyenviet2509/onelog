---
title: Alert triage — reduce Telegram noise (chronic + cascade + false positive)
slug: alert-triage-telegram-noise-reduction
date: 2026-08-26
type: brainstorm
status: agreed
approach: A + B combo (Alertmanager tuning + rule-level hysteresis)
host: onelog-vps (prod)
followup_to:
  - plans/reports/brainstorm-260826-0926-vector-dedup-scale-100-host.md
---

# Alert triage — Telegram noise reduction

## Problem statement

29 alerts đang firing sáng 2026-08-26. Nhóm thành 4 clusters:

| Cluster | Alertname | Hosts | Severity | Root cause |
|---|---|---|---|---|
| A | OomKillEvent (lsphp) | 8 shared-hosting | critical | PHP worker limit vs RAM, malicious WP script |
| B | SystemdServiceFailed (db_governor) | 9 nethost | warning | CloudLinux governor crash from memory pressure |
| C | SystemdSessionLimitReached | 2 hosts | critical | pam session leak — cron/sudo orphan |
| D | SudoEscalation, SmtpDeliveryFailure | mailer-01/02 | warning | Zimbra maintenance loop (false positive) |

**Correlations detected:**
- `nethost-2011`, `5311`, `6211`: **OOM + db_governor cùng lúc** → 1 root cause (memory pressure) → 2 alerts độc lập
- Zimbra sudo activity trên mailer là expected Zimbra maintenance, không phải security incident

**Noise math:**
- Alertmanager `group_by: [alertname, severity, category]` đã dedup cross-host ✅
- Chronic alerts fired 20+ ngày × `repeat_interval: 4h` (warning), 30m (critical)
- 15 chronic groups × 2-6 nhắc lại/ngày = **~60-90 Telegram msg/day** noise

**User complaint:** Ops team ignore Telegram vì chronic drowns fresh incidents.

## Current state analysis

### Alertmanager (infra/alertmanager/alertmanager.yml)
- ✅ `group_by: [alertname, severity, category]` — 200-host burst = 1 msg
- ✅ `notify_style=event` label → skip RESOLVED noise
- ✅ Compact template render khi >5 hosts
- ❌ **`inhibit_rules: []` empty** — không có cascade suppression
- ❌ `repeat_interval` fixed (4h/30m) — chronic vs new indistinguishable

### vmalert rules (infra/vmalert/rules.yml)
- Event rules: `for: 0s` → fire ngay khi thấy 1 log line, no hysteresis
- Burst rules: `for: 5m` với threshold-based → OK cho patterns thật
- ❌ Không có `keep_firing_for` → alert stays firing forever until vmalert restart or query returns 0

## Evaluated approaches

### A: Alertmanager-side tuning (KISS, 30 min)
Pure config, zero rule migration.
1. `repeat_interval` bump: warning 4h → **12h**, critical 30m → **2h**
2. Add `inhibit_rules`:
   - `OomKillEvent` (source) → suppress `SystemdServiceFailed` (target) equal `[host]`
   - `OomKillEvent` (source) → suppress `SystemdSessionLimitReached` (target) equal `[host]`
   - `DiskFullErrors` (source) → suppress any `severity=warning` equal `[host]`
3. Zimbra false positive: exclude `host=~mailer-.*` trong `SudoEscalation` rule expr OR routing skip

**Impact:**
- Chronic noise: 60-90 → ~20/day (65% reduction)
- Cascade cleanup: nethost-2011 OOM + db_governor = 1 msg thay vì 2

### B: Rule-level hysteresis + auto-resolve (medium, 1-2h)
Root-cause solve chronic re-fire.
1. Event rules add `keep_firing_for: 30m` — alert auto-resolves nếu quiet 30 min (vmalert ≥1.100)
2. Burst rules: `for: 5m` → `for: 15m` cho warning (validate sustained pattern)
3. Include A's inhibit rules
4. `repeat_interval` bump moderate: warning 4h → **6h**

**Impact:**
- Chronic tự động resolved khi log stream ngưng → nethost-2011 lsphp OOM 20d firing sẽ resolve trong 30m quiet windows
- Telegram sạch tự nhiên, không cần manual silence

**Prerequisite:** verify vmalert version ≥1.100 on prod

### C: Chronic-vs-new digest routing (complex, 2-3h)
2-tier: alerts firing >24h auto-route to daily digest topic.
- Cần OneMCP relay code hoặc custom label injection
- Alertmanager không natively support alert-age routing

**Impact:** ~95% Telegram reduction nhưng complexity cao. YAGNI defer.

### D: Do nothing
Chronic alerts sẽ tự tail off khi ops team fix client-side. Ops nói vấn đề nằm ở khách hàng shared hosting, chậm resolve.

## Final recommendation: **A + B combo**

**Rationale:**
- A: immediate 65% reduction (30 min config edit + restart alertmanager)
- B: root-cause fix cho chronic re-fire (1h edit rules.yml + verify vmalert)
- Total ~90 min effort, expected **85-90% noise reduction**
- Skip C: over-engineered nếu A+B đủ. Re-evaluate sau 7 ngày.

## Design outline

### Phase 1 — Alertmanager config edits (30 min)

**File:** `infra/alertmanager/alertmanager.yml`

Change 1: bump repeat_intervals
```yaml
route:
  # ... existing ...
  repeat_interval: 12h              # was: 4h — chronic re-notify less noisy
  routes:
    - matchers:
        - severity="critical"
      receiver: telegram-client-server
      repeat_interval: 2h           # was: 30m — critical still responsive
```

Change 2: add inhibit_rules (populate empty array)
```yaml
inhibit_rules:
  # Memory cascade: OOM triggers systemd/db_governor crash on same host
  - source_matchers:
      - alertname="OomKillEvent"
    target_matchers:
      - alertname=~"SystemdServiceFailed|SystemdSessionLimitReached"
    equal: [host]

  # Disk full triggers all subsequent warnings on same host
  - source_matchers:
      - alertname="DiskFullErrors"
    target_matchers:
      - severity="warning"
    equal: [host]
```

Change 3: Zimbra false positive exclude — 2 options
- **Option A** (rule-level, preferred): edit `SudoEscalation` expr thêm `NOT host:mailer-*`
- **Option B** (routing): add matcher trong alertmanager route để mailer-* + SudoEscalation → silence receiver

### Phase 2 — vmalert rule hysteresis (1h)

**File:** `infra/vmalert/rules.yml`

Change 1: verify vmalert version supports `keep_firing_for`
```bash
docker exec ragstack-vmalert vmalert --version
# Need ≥1.100
```

Change 2: add `keep_firing_for` to event rules (line 33, 45, 59, 73, 91)
```yaml
- alert: OomKillEvent
  expr: '...'
  for: 0s
  keep_firing_for: 30m    # NEW — auto-resolve after 30m quiet
  labels: ...
```

Change 3: burst rules bump `for` to 15m for warnings

### Phase 3 — Deploy + verify (15 min)

1. Local edit → commit → push → VPS git reset
2. Restart alertmanager (config validate first)
3. Reload vmalert (`docker exec ragstack-vmalert wget -qO- http://localhost:8880/-/reload`)
4. Monitor Telegram 24h — chronic alerts should resolve within 30m quiet or stay silent

## Implementation considerations

- **Backwards compat:** repeat_interval bump = pure Alertmanager config, zero risk
- **Testing inhibit rules:** create test alert `OomKillEvent` for fake host, verify `SystemdServiceFailed` on same host doesn't fire in Telegram
- **`keep_firing_for` behavior:** if vmalert < 1.100, fallback: reduce `interval` for event rules (`30s` → `1m`) and rely on natural resolution
- **Zimbra exclusion side effect:** genuine sudo on mailer-01/02 sẽ bị suppress. Trade-off acceptable — those hosts đã có mail-team monitoring topic riêng

## Risks + mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Real cascade alert bị inhibit khi source non-related (e.g. OOM + genuine unrelated systemd failure) | Miss real incident | Inhibit theo `equal: [host]` chỉ suppress same-host correlation. Different-host alerts independent |
| Bumped repeat_interval delays new incident re-notification | Ops miss follow-up | New incident fires immediately (first-time), repeat only kicks in after initial batch — no impact on fresh signals |
| vmalert version < 1.100 (keep_firing_for unavailable) | Phase B blocked | Fallback: docs suggest manual silence via curl API, or wait for next vmalert upgrade |
| Zimbra sudo exclusion masks real Zimbra compromise | Security miss | Add high-threshold alert (>500 sudo/5m) as final safety net |

## Success metrics

- Telegram msg/day: **60-90 → <15/day** target (85% reduction)
- Chronic groups auto-resolve within 30m quiet window
- Zero false-positive Zimbra alerts
- Fresh incidents still notify <5 min (critical) / <15 min (warning)
- No missed real incidents during 7-day monitor post-deploy

## Success criteria for validation

- Post-deploy 24h: verify no chronic re-notify từ nethost-* db_governor (was every 4h)
- Trigger test OOM on canary host → verify SystemdServiceFailed on same host doesn't fire in Telegram (inhibit works)
- Fresh critical alert (new host) → notify <5 min (repeat_interval bump doesn't delay first fire)

## Next steps

1. Create implementation plan cho A+B combo
2. Verify vmalert version on prod
3. Execute plan
4. Monitor 7 days, tune if needed

## Unresolved

1. Vmalert version — cần verify ≥1.100 cho `keep_firing_for` support
2. Zimbra sudo threshold — nếu chọn rule-level filter thay vì exclusion, threshold nào an toàn (100 sudo/5m acceptable? 500?)
3. `SmtpDeliveryFailure` mailer-0104 — có phải noise (upstream MTA maintenance) hay real signal? cần ops team confirm
4. Repeat_interval 12h cho warning — có quá thưa không nếu chronic hết tự resolve? có thể bump 24h nếu Phase B `keep_firing_for` work tốt
