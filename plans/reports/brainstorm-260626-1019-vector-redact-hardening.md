# Brainstorm — Vector redact hardening

**Date:** 2026-06-26
**Scope:** `infra/vector/vector.yaml` transform `redact` + `rsyslog_json_normalize`
**Status:** Approved, proceed to direct implementation (KISS scope, 1 file).

## Problem

Current redact config có 1 bug FP nghiêm trọng + thiếu coverage 3 high-value secret types + chưa cap length per-event + chưa observability + JSON path bypass redact via `labels.*` pass-through.

## Key finding

Vector dùng Rust `regex` crate (RE2-style, **không backtracking**). ReDoS không thể xảy ra → concern "regex bùng nổ CPU do backtracking" N/A. Throughput vẫn phụ thuộc msg length × số regex tuần tự → cần length cap.

## Issues phát hiện

| # | Severity | Vấn đề | Fix |
|---|---|---|---|
| 1 | 🔴 HIGH | Password regex match cả whitespace delimiter → `password is required` bị mangle | Đổi `["\s:=]+` → `\s*[:=]\s*`, thêm `\b` boundary |
| 2 | 🔴 HIGH | JSON path 6515 không redact `labels.*`/`trace.*` | Denylist key name trong `rsyslog_json_normalize` |
| 3 | 🟡 MED | Thiếu pattern GH PAT, DB conn string, PEM private key | Thêm 3 regex |
| 4 | 🟡 MED | Không có metric đếm redaction | Thêm field `redacted=true`; query VL `count(redacted:true) by service` |
| 5 | 🟡 MED | Không cap msg length → log MB tốn CPU | `slice!(msg, 0, 65536)` trước redact |
| 6 | 🟢 LOW | JWT regex FP nhẹ | Accept |
| 7 | 🟢 LOW | RFC1918 không bound 0-255 | Accept (redact đúng intent) |

## Null safety / escaping — đã đúng

- `msg = string(._msg) ?? ""` chuẩn pattern fallible cast + fallback.
- Tất cả regex dùng raw string `r'...'`. ✅
- Bearer regex comment đã note pitfall `$N` env-var interpolation → KISS: tránh dùng backref, replace literal.

## Loss of casing — accepted trade-off

`PASSWORD=foo` → `password=<REDACTED>` (mất casing field name). Bảo mật > debug aesthetics.

## Final config (vùng thay đổi)

### Transform `redact` (vector.yaml)

```vrl
source: |
  msg = string(._msg) ?? ""
  msg = slice!(msg, 0, 65536)
  original = msg

  msg = replace(msg, r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', "<EMAIL>")
  msg = replace(msg, r'\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b', "<PRIV_IP>")
  msg = replace(msg, r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', "<JWT>")
  msg = replace(msg, r'AKIA[0-9A-Z]{16}', "<AWS_KEY>")
  msg = replace(msg, r'(?i)authorization:\s*bearer\s+[A-Za-z0-9._-]+', "Authorization: Bearer <TOKEN>")
  msg = replace(msg, r'(?i)\b(password|passwd|pwd|passphrase)\s*[:=]\s*\S+', "password=<REDACTED>")
  msg = replace(msg, r'\bgh[opsu]_[A-Za-z0-9]{36,255}\b', "<GH_PAT>")
  msg = replace(msg, r'(?i)(postgres|postgresql|mysql|mongodb|redis|amqp)://[^:\s]+:[^@\s]+@\S+', "<DB_URL>")
  msg = replace(msg, r'-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED |)PRIVATE KEY-----[^-]+-----END [^-]+-----', "<PRIVATE_KEY>")

  if msg != original { .redacted = true }
  ._msg = msg
```

### Transform `rsyslog_json_normalize` — strip sensitive labels

Sau gán `labels`:

```vrl
if labels != null {
  del(labels.password)
  del(labels.passwd)
  del(labels.token)
  del(labels.api_key)
  del(labels.apikey)
  del(labels.secret)
  del(labels.authorization)
  .labels = labels
}
```

## Skipped (YAGNI)

- Slack/Stripe pattern — stack không dùng.
- AWS ASIA/secret key 40-char — high FP.
- CCCD VN (12 digits) — high FP với order ID/timestamp.
- SĐT VN — chưa confirm có log PII khách hàng.
- Recursive redact mọi string field JSON — over-engineer khi denylist key đủ.

## Validation plan

1. `docker compose exec vector vector validate /etc/vector/vector.yaml`
2. Fixture test: `logger -t test "password is required"` → VL phải giữ nguyên (no FP).
3. Fixture test: `logger -t test "password=hunter2"` → VL phải show `password=<REDACTED>`.
4. Fixture test mỗi pattern mới (GH PAT, DB URL, PEM) tương tự.
5. Monitor 24h: `service:* redacted:true | stats count() by (service)` baseline.

## Rollback

`git revert` trên vector.yaml + `docker compose restart vector` (≤5s downtime, log buffered tại rsyslog client).

## Risks

| Risk | Mitigation |
|---|---|
| Vector validate fail vì syntax VRL | Test local trước, dùng `vector validate` |
| `slice!` không expect msg là string | Đã `string() ?? ""` → guaranteed string |
| Field `.redacted` clash với schema VL | VL schema-less, OK |

## Unresolved questions

- Cần exposeProm metric chi tiết per-pattern (không chỉ binary `redacted:true`)? — Defer, đợi xem có need thực tế.
- Có nên redact luôn cho debug_file sink? — Hiện đã redact vì sink `debug_file` đọc từ `redact` output. ✅ OK.
