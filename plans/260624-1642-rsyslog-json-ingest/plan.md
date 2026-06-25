---
name: rsyslog-json-ingest
status: code-complete
created: 2026-06-24
updated: 2026-06-25
owner: vietnt
blockedBy: []
blocks: []
relatedReports:
  - plans/reports/brainstorm-260624-1642-rsyslog-json-ingest.md
relatedPlans:
  - plans/260622-1056-rag-logserver-victorialogs
progress:
  P1-vector-source: code-done (deploy + smoke pending)
  P2-client-config: code-done
  P3-e2e-test-container: code-done (run + verify pending)
  P4-test-scenarios: code-done (run pending)
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
| 1 | Vector source + normalize transform | [phase-01-vector-source-normalize.md](phase-01-vector-source-normalize.md) | code-done, deploy pending | ~3h |
| 2 | Client rsyslog config + onboarding doc | [phase-02-client-config-doc.md](phase-02-client-config-doc.md) | code-done | ~2h |
| 3 | E2E test rsyslog container | [phase-03-e2e-test.md](phase-03-e2e-test.md) | code-done, run pending | ~3h |
| 4 | Test scenarios mở rộng (B/C/D/E/F) | [phase-04-test-scenarios.md](phase-04-test-scenarios.md) | code-done, run pending | ~5h |

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
