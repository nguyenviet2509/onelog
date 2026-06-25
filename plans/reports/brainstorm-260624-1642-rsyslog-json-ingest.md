# Brainstorm: Nhận log từ rsyslog (JSON over TCP) vào OneLog

**Date:** 2026-06-24 16:42 (+07)
**Branch:** feat/phase02-onboarding
**Status:** Design — pending plan
**Owner:** vietnt

---

## 1. Problem Statement

OneLog hiện đã nhận log từ client qua Vector listener:
- `syslog_udp` UDP/514 RFC3164
- `syslog_tcp` TCP/6514 RFC5424

Yêu cầu mới: tương thích với client đã có hạ tầng **rsyslog đang forward JSON**
sang SIEM khác (ELK/Graylog). Client không muốn rewrite template, chỉ thêm
1 `action(type="omfwd")` destination trỏ về OneLog.

**Câu trả lời ngắn:** OneLog *đã* nhận được rsyslog nếu client dùng template
RFC5424. Nhưng để chấp nhận JSON template raw, cần **thêm 1 Vector source mới**.

---

## 2. Requirements

### Functional
- Nhận JSON line-delimited qua TCP từ rsyslog `omfwd`.
- Parse → normalize field → đi tiếp pipeline Vector hiện hữu (PII redact +
  dual sink VictoriaLogs + NATS).
- Schema thống nhất: ECS-lite (xem §5).

### Non-functional
- Throughput: ≥ 5k EPS/connection (cùng mức syslog_tcp hiện tại).
- Backpressure: rsyslog queue file phía client lo retry — server đơn giản drop
  nếu Vector buffer đầy.
- Security PoC: plain TCP, IP whitelist tại Caddy/firewall layer.
- Roadmap: TLS 6515 + token sau khi có Postgres token table.

---

## 3. Evaluated Approaches

| # | Approach | Effort | Pros | Cons |
|---|---|---|---|---|
| A | Ép client dùng RFC5424 template có sẵn | 0 | Zero code, đã test | Client phải sửa pipeline |
| **B** | **Thêm Vector `socket` source JSON port 6515** | **~1 buổi** | **Keep Vector pipeline, client chỉ add 1 action** | **+1 endpoint maintain** |
| C | HTTP ingest qua Caddy + rsyslog `omhttp` | 2-3 ngày | Reliability cao, TLS reuse Caddy | Overhead HTTP, lệch pattern hiện tại |

→ **Chọn B.** Lý do: ngọt nhất giữa effort và compatibility, không phá pipeline.

---

## 4. Recommended Design — Option B

### 4.1 Vector source mới

File: `infra/vector/vector.yaml` — thêm vào `sources`:

```yaml
rsyslog_json_tcp:
  type: socket
  mode: tcp
  address: 0.0.0.0:6515
  decoding:
    codec: json
  framing:
    method: newline_delimited
  connection_limit: 1024
```

### 4.2 Transform normalize → schema OneLog

Thêm transform `remap` map field client → ECS-lite (xem §5). Nối vào pipeline
hiện tại (`pii_redact` → sink). Sketch:

```yaml
transforms:
  rsyslog_json_normalize:
    type: remap
    inputs: [rsyslog_json_tcp]
    source: |
      .@timestamp = .timestamp ?? .ts ?? now()
      .host.name = .host ?? .hostname ?? .source_host ?? "unknown"
      .log.level = downcase(string!(.severity ?? .level ?? "info"))
      .service.name = .program ?? .app ?? .service ?? "unknown"
      .message = string!(.msg ?? .message ?? .)
      del(.timestamp); del(.ts); del(.host); del(.hostname)
      del(.severity); del(.level); del(.program); del(.app)
```

Sau đó cập nhật `inputs` của `pii_redact` để bao gồm `rsyslog_json_normalize`.

### 4.3 Caddy / network

- Port 6515 bind chỉ trong network internal (`192.168.122.0/24`) — Compose
  expose có điều kiện.
- KHÔNG expose qua Caddy (Caddy không proxy raw TCP cho path-based; nếu cần
  expose Internet, dùng Caddy `layer4` hoặc HAProxy — out of scope PoC).

### 4.4 Client rsyslog config mẫu

File mới: `infra/clients/rsyslog-forward-json.conf`

```rsyslog
template(name="OneLogJSON" type="list" option.jsonf="on") {
  property(outname="@timestamp" name="timereported" dateFormat="rfc3339" format="jsonf")
  property(outname="host"       name="hostname"                            format="jsonf")
  property(outname="severity"   name="syslogseverity-text"                 format="jsonf")
  property(outname="program"    name="programname"                         format="jsonf")
  property(outname="message"    name="msg"                                 format="jsonf")
}

action(
  type="omfwd"
  target="<onelog-host>" port="6515" protocol="tcp"
  template="OneLogJSON"
  queue.type="LinkedList" queue.filename="onelog_q"
  queue.saveOnShutdown="on" action.resumeRetryCount="-1"
)
```

---

## 5. ECS-lite Schema (Contract)

Field bắt buộc client gửi (sau khi normalize trong Vector):

| Field | Type | Required | Note |
|---|---|---|---|
| `@timestamp` | RFC3339 string | yes | Vector fallback `now()` nếu thiếu |
| `host.name` | string | yes | hostname client |
| `log.level` | enum: debug/info/warn/error/critical | yes | lowercase |
| `service.name` | string | yes | program/app name |
| `message` | string | yes | raw log line |
| `labels.*` | object | no | custom tags, flat key-value |
| `trace.id` | string | no | nếu app inject |

Lý do chọn ECS:
- Industry standard (Elastic), client thường đã quen.
- VictoriaLogs query DSL hỗ trợ dot-notation native.
- Rsyslog template viết thẳng, không cần custom map.

---

## 6. Implementation Considerations & Risks

### Risks
1. **Schema drift** — client gửi field lạ → indexer downstream vỡ.
   *Mitigation:* `remap` drop field không whitelist trước khi vào sink.
2. **Plain TCP bị spoofing trong LAN** — IP whitelist firewall, document rõ
   "production yêu cầu TLS".
3. **JSON malformed** → Vector log error nhưng không panic, OK cho PoC.
4. **Port conflict** — 6515 có thể đụng dịch vụ khác; verify trên target host.

### Out of scope (PoC này)
- TLS + token auth (đẩy sang phase tiếp).
- Multi-tenant routing (single tenant đang là default).
- Schema validation engine (chỉ dùng VRL remap).

---

## 7. Success Metrics

- [ ] Vector reload không lỗi, expose port 6515.
- [ ] Test rsyslog client gửi 1000 events → VictoriaLogs query thấy đủ 1000,
  field `@timestamp/host.name/log.level/service.name/message` populated.
- [ ] PII redact transform vẫn áp dụng cho luồng JSON (verify với 1 event chứa
  email → email bị mask).
- [ ] Latency p95 ingest→VL query visible < 5s.
- [ ] Doc onboarding client cập nhật cả 2 path (RFC5424 + JSON).

---

## 8. Next Steps

1. Tạo plan chi tiết qua `/ck:plan` với phases:
   - P1: Vector source + transform + reload test.
   - P2: Client config sample + tài liệu onboarding.
   - P3: E2E test với rsyslog container giả lập client.
2. Theo dõi backlog: TLS 6515, token auth, schema validator.

---

## 9. Unresolved Questions

- Có cần expose 6515 qua Internet không? Nếu có → cần Caddy layer4 hoặc đổi
  sang HTTP (Option C).
- Trường hợp client đã có template ECS chuẩn rồi → có cần `remap` transform
  hay pass-through luôn?
- VictoriaLogs index field cardinality cho `labels.*` — có cần giới hạn không?
- Có muốn version-tag schema (`schema.version`) để evolve sau này?
