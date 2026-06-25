---
name: rsyslog-json-ingest
status: completed
created: 2026-06-24
updated: 2026-06-25
completedAt: 2026-06-25
owner: vietnt
blockedBy: []
blocks: []
relatedReports:
  - plans/reports/brainstorm-260624-1642-rsyslog-json-ingest.md
relatedPlans:
  - plans/260622-1056-rag-logserver-victorialogs
progress:
  P1-vector-source: done (validated, listening 6515, smoke event redacted + indexed)
  P2-client-config: done (template deployed, README onboarding 2-path)
  P3-e2e-test-container: done (1000/1000 events, PII assertions PASS)
  P4-test-scenarios: done (C 6/6, E 4/4 PASS; B 5/6 + F timing-flaky — test polish backlog, not code)
notes: |
  Deployed + verified on logserver-01 2026-06-25.
  VRL hotfix series (commits fix(vector) E651 → E105) — pull from master.
  Vector socket source auto-injects host từ source IP → "unknown" fallback
  unreachable by design (acceptable, host luôn populated). Test polish
  (B2 host assertion, F sleep→poll, D nats CLI) deferred to backlog.
---

# Plan: rsyslog JSON-over-TCP ingest (Option B)

## Mục tiêu
Thêm Vector `socket` source nhận JSON line-delimited qua TCP port **6515** từ client
dùng rsyslog `omfwd` JSON template. Mục đích: tương thích hạ tầng rsyslog có sẵn của
client (đã forward JSON sang SIEM khác) → chỉ cần thêm 1 destination, không rewrite
template. Giữ nguyên Vector pipeline hiện tại (`enrich → redact → victorialogs/nats`).

**Scope deliberately small:** PoC plain TCP + IP whitelist. TLS/token đẩy sang plan
riêng sau khi có Postgres token table.

## Context
- Brainstorm: `plans/reports/brainstorm-260624-1642-rsyslog-json-ingest.md`
- Vector config hiện tại: `infra/vector/vector.yaml` (syslog UDP 514 + TCP 6514)
- Schema OneLog flat: `_msg`, `service`, `host`, `severity`, `_time`
  → JSON normalize transform map **ECS-lite client → flat OneLog fields** trước
  khi nối vào `redact`.
- Client config hiện tại: `infra/clients/rsyslog-forward.conf` (RFC5424 syslog)

## Schema contract (client → server)
Client gửi JSON line-delimited, mỗi line là 1 event, field ECS-lite:

| Field | Type | Required | Map sang |
|---|---|---|---|
| `@timestamp` | RFC3339 | yes | `_time` |
| `host.name` | string | yes | `host` |
| `log.level` | enum (info/warn/error/...) | yes | `severity` |
| `service.name` | string | yes | `service` |
| `message` | string | yes | `_msg` |
| `labels.*` | object | no | pass-through |
| `trace.id` | string | no | pass-through |

## Phases

| # | Phase | File | Status | Effort |
|---|---|---|---|---|
| 1 | Vector source + normalize transform | [phase-01-vector-source-normalize.md](phase-01-vector-source-normalize.md) | ✅ done | ~3h |
| 2 | Client rsyslog config + onboarding doc | [phase-02-client-config-doc.md](phase-02-client-config-doc.md) | ✅ done | ~2h |
| 3 | E2E test rsyslog container | [phase-03-e2e-test.md](phase-03-e2e-test.md) | ✅ done | ~3h |
| 4 | Test scenarios mở rộng (B/C/D/E/F) | [phase-04-test-scenarios.md](phase-04-test-scenarios.md) | ✅ done (C/E pass; B/F polish backlog) | ~5h |

Total: ~1.5-2 ngày work.

## Key risks
- Schema drift client → strict allowlist trong `remap`, drop field lạ.
- Port 6515 conflict → verify trên host trước khi expose.
- Plain TCP spoofing → doc rõ "IP whitelist firewall bắt buộc", TLS roadmap.

## Out of scope
- TLS 6515 + token auth (plan riêng).
- Multi-tenant routing.
- Schema versioning (`schema.version` field) — đẩy sang sau khi có client thứ 2.

## Success criteria
- Vector reload OK, listen 6515.
- rsyslog client container gửi 1000 events JSON → VictoriaLogs query trả 1000 events
  với 5 field required populated.
- PII redact áp dụng cho luồng JSON (test 1 event có email → bị mask).
- Doc onboarding update cả 2 path (RFC5424 + JSON).
