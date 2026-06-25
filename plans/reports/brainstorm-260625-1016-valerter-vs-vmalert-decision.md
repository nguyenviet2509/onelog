# Decision: KHÔNG replace vmalert + alertmanager bằng Valerter

**Date:** 2026-06-25 10:16 (+07)
**Branch:** master
**Status:** Decision — keep vmalert+alertmanager, revisit Valerter sau 1-2 tháng
**Owner:** vietnt

---

## Question
[fxthiry/Valerter](https://github.com/fxthiry/Valerter) là Rust binary stream-tail
VictoriaLogs, push notification real-time (Mattermost/Telegram/Webhook/SMTP).
Có nên replace vmalert + alertmanager không?

## Tóm tắt: KHÔNG. Giữ nguyên (Option A).

## So sánh model

| Khía cạnh | vmalert + alertmanager | Valerter |
|---|---|---|
| Trigger | Stats query định kỳ (count > N over Nm) — **threshold/trend** | Stream tail từng log line — **event/immediate** |
| Latency | 5m (default interval) | < 5s |
| Throttle | Alertmanager group/inhibit/silence UI | Per-key rate limit only |
| Notif | Receivers webhook + alertmanager-bridge | Built-in Mattermost/Telegram/Email/Webhook |
| Maturity | VM ecosystem, battle-tested | Rust 1.85+ (2025-03), single maintainer, repo nhỏ |
| Multi-tenancy | Per vmalert instance | 1 instance tail nhiều VL backends |
| Prom integration | vmalert ghi ALERTS{} vào VM | /metrics endpoint riêng |
| Resource | 2 Go container | 1 Rust binary |

## Lý do giữ vmalert+alertmanager

1. **12 rule hiện tại đều threshold-based** (`count() > N`). Valerter KHÔNG có
   model này → replace = phải re-design hết 12 rule, mất semantic burst-detection.
   "30 SSH fail/5m" không equivalent với "fire mỗi line + throttle".
2. **Mất features alertmanager:** group_by, inhibition (1 alert silence cái khác),
   silences UI/API, route trees, time-based muting.
3. **OneLog scope** = MCP-only single-node 5 ops internal team. 5m latency
   chấp nhận được. Không có use case sub-5s nào trong rules.yml hiện tại.
4. **Valerter risk:** single maintainer (bus factor=1), v2.0.0 breaking changes
   vừa landed, Rust 1.85 requirement = build chain mới, prebuilt artifact chưa
   chắc work với Alpine base.
5. **Scope creep cost cao hơn marginal benefit.** Thêm 1 alert system = +1
   config format ops phải học + +1 service maintain.

## Khi nào revisit Valerter

Bật cờ revisit nếu xảy ra **≥1 trong**:
- Có ≥3 use case CỤ THỂ cần alert sub-5s (kernel panic, app crash specific
  stacktrace, replication broken, disk I/O error, cert expired hard-fail).
- vmalert+alertmanager queue/latency vượt SLO ops cần.
- Onboard ≥3 team có VL backend riêng cần multi-source aggregation (Valerter
  multi-source spec mạnh hơn vmalert per-instance).

## Alternative nhẹ (nếu cần sub-5s event later)

KHÔNG cần Valerter — dùng Vector sink:

```yaml
sinks:
  critical_event_webhook:
    type: http
    inputs: [redact]
    uri: https://hooks.slack.com/...
    method: post
    encoding: { codec: json }
    # Pattern filter via VRL transform trước sink:
```
+ 1 transform `filter` type matching `facility:kern AND _msg:"panic"`.
Effort ~30 phút, in-house, không thêm dependency.

## Unresolved

- Có thực sự có pain point latency 5m không? Nếu chưa, không cần action gì.
- Có khả năng ops team muốn UI silence/inhibit alert không? Alertmanager UI
  hiện đang đủ chưa? Audit ops feedback sau 1 tháng.
