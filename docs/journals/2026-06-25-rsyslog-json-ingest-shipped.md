# rsyslog JSON-over-TCP ingest shipped

**Date:** 2026-06-25
**Plan:** [260624-1642-rsyslog-json-ingest](../../plans/260624-1642-rsyslog-json-ingest/)
**Status:** ✅ Deployed + verified on logserver-01.

## What landed
- Vector `socket` source on TCP **6515** với JSON line-delimited codec.
- VRL transform `rsyslog_json_normalize` map ECS-lite client schema
  (`@timestamp`, `host.name`, `log.level`, `service.name`, `message`,
  optional `labels.*`, `trace.id`) → flat OneLog (`_time`, `host`, `severity`,
  `service`, `_msg`). Whitelist top-level keys = drop unknown → guard schema drift.
- Pipeline chain: `rsyslog_json_tcp → rsyslog_json_normalize → redact → {VL, NATS warn}`.
- Client rsyslog template `infra/clients/rsyslog-forward-json.conf` + 2-path
  onboarding doc `infra/clients/README.md` (RFC5424 vs JSON ECS-lite).
- E2E test rig `tests/rsyslog-e2e/` (Alpine + rsyslog container) + 5 scenario
  scripts B/C/D/E/F + Makefile.

## What didn't go to plan
- **VRL hotfix x2.** Vector 0.40 VRL strict mode:
  - E651: path access `.foo` is infallible — `??` chain rejected. Wrap with
    `string()` (fallible cast) to justify coalesce.
  - E105: `to_timestamp()` does NOT accept string input. Switch to
    `parse_timestamp(value, format: "%+")`.
  - Lesson: validate VRL with `docker run vector validate` *before* touching
    running stack. Saved 1 redeploy cycle on hotfix #2.
- **Vector socket source auto-injects `host` field từ source IP.** "Missing host
  → fallback unknown" test scenario unreachable by design. Acceptable behavior
  (host luôn populated), test assumption sai. Backlog: disable via `host_key: ""`
  hoặc fix assertion.
- **F resilience test sleep ngắn.** Rsyslog client cần > 12s để reconnect + drain
  queue + Vector batch flush sau khi vector recovered. Test assertion ran trước
  drain xong → false fail. Diagnostic 2 phút sau: 150/150 events landed. Polish:
  poll-with-retry thay sleep fixed.

## Verified results
| Phase | Assert |
|---|---|
| P3 smoke 1000 events | 1000/1000 in VL, PII redact OK |
| Scenario C (PII 6 patterns) | 6/6 PASS — email/priv_ip/jwt/aws_key/bearer/password |
| Scenario E (3-path coexist) | 300/300 events across UDP 514 + TCP 6514 + JSON 6515 |
| Scenario B (schema) | 5/6 PASS (B2 = false positive) |
| Scenario F (resilience) | drain works, assertion timing flaky |
| Scenario D (severity routing) | SKIP — nats CLI chưa cài |

## What changed for client onboarding
Client với rsyslog ≥ 8.x giờ có **2 options** thay vì 1:
- **Option A** (default): RFC5424 syslog qua TCP 6514 — không đổi.
- **Option B** (new): JSON ECS-lite qua TCP 6515 — dành cho client đã có
  rsyslog pipeline forward JSON sang SIEM khác, chỉ cần thêm 1 `action()`,
  không rewrite template.

Schema contract gắt: 5 field bắt buộc + 2 optional pass-through. Unknown
field bị Vector normalize drop (anti-drift).

## Open items
- Test polish (B2 assertion, F poll-retry, D nats CLI install).
- TLS + token auth cho 6515 (đẩy sang plan riêng — production roadmap).
- Multi-tenant routing (nếu cần khi onboard client > 1 org).
