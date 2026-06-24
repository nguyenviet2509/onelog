# Phase 03 — PII Redaction Hardening

## Context
- [plan.md](plan.md) | [Brainstorm §Stage 3](../reports/brainstorm-260623-1617-production-rollout.md)

## Overview
- Priority: **P0 (critical với PII customer thật)**
- Status: pending
- Effort: 2-3 ngày
- Mục tiêu: Expand redaction regex, fail-closed assert, post-ingest audit job daily, legal-grade policy doc. 1 leak = legal incident.

## Requirements
- Vector regex cover: email, phone VN, CCCD/CMND, credit card, JWT, API key prefix, IPv4 public, **PII format khách hàng custom** (từ Phase 00 sample)
- Fail-closed: drop line nếu match un-redacted pattern (assert transform)
- Post-ingest audit: cron grep VL data daily, report leak count
- Drain3 template review: variable không chứa giá trị PII
- Policy doc `docs/pii-policy.md` cho legal review

## Related files
- `infra/vector/vector.yaml` — extend redaction transform
- `infra/vector/redaction-patterns.yaml` — **create** (modularize patterns)
- `infra/scripts/pii-audit-daily.sh` — **create**
- `infra/scripts/pre-ingest-sample.sh` — **create** (1k line audit thủ công)
- `docs/pii-policy.md` — **create**
- `agent/src/agent/redaction.py` — **create** nếu cần redact ở agent layer (defense-in-depth)

## Implementation steps
1. Pull sample 100-500 line / 5 prod server → write tới `samples/{server}.log`
2. Manual grep: tìm pattern PII mà regex hiện tại miss
3. Build regex list:
   - Email: `[\w.+-]+@[\w-]+\.[\w.-]+`
   - Phone VN: `(\+84|0)\d{9,10}`
   - CCCD: `\b\d{9}\b|\b\d{12}\b` (cẩn thận false positive)
   - Credit card: `\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b` + Luhn check
   - JWT: `eyJ[\w-]+\.[\w-]+\.[\w-]+`
   - API key: `(sk|pk|api[_-]?key)[_-][\w]{20,}`
   - IPv4 public (skip private ranges): regex + filter 10/8, 172.16/12, 192.168/16
   - **Custom khách hàng**: thêm sau khi analyze sample
4. Update `vector.yaml` redact transform:
   - VRL `replace(..., regex, "<EMAIL>")` chain
5. Add assert transform `pii_check`:
   - Nếu vẫn match pattern sau redact → drop line, increment metric `pii_leak_dropped_total`
6. Pre-ingest dry run script: input log file, output redacted + un-redacted count
7. Run pre-ingest trên 5 server sample → 0 leak là pass
8. Post-ingest audit script: `vlogs query 'last 24h' | grep -P 'patterns' | wc -l`, alert nếu > 0
9. Drain3 template export → review: template không có dữ liệu thật
10. Write `docs/pii-policy.md`: what redacted, how stored, who access, retention, deletion procedure
11. Legal review document

## Todo
- [ ] Sample 5 server pulled
- [ ] PII patterns identified
- [ ] vector.yaml redact + assert transform updated
- [ ] Pre-ingest dry-run passes 0 leak/5 server
- [ ] Post-ingest audit script + cron
- [ ] Drain3 template review
- [ ] docs/pii-policy.md committed
- [ ] Legal review signed off

## Success criteria
- Pre-ingest dry-run 0 leak qua 1000 lines/server
- Post-ingest audit 0 hit trong 7 ngày soak
- Drain3 template không chứa giá trị thật (chỉ wildcard `<*>`)
- Legal policy signed (file lưu trữ)

## Risks
- Regex false positive drop log hợp lệ → monitor `pii_leak_dropped_total`, tune
- Customer PII format đặc biệt khó regex → fallback whitelist-based (chỉ ingest pattern đã biết)
- Vector assert drop có thể làm mất data quan trọng → ship dropped lines sang quarantine bucket riêng để review

## Security
- Sample log thủ công xoá ngay sau analyze (không lưu git)
- pii-policy.md mark `internal` không public
- Audit script chạy với quyền read-only

## Next steps
- Phase 04 onboard client phải dùng patterns đã verify
- Phase 06 post-ingest audit script vào oncall alert
