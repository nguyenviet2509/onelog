# Phase 00 — Pre-flight Gating

## Context
- [plan.md](plan.md)
- [Brainstorm report §Stage 0](../reports/brainstorm-260623-1617-production-rollout.md)

## Overview
- Priority: **P0 (blocker)**
- Status: pending
- Effort: 1-2 ngày (chủ yếu chờ stakeholder reply)
- Mục tiêu: Resolve 8 unresolved question + legal signoff trước khi đụng infra.

## Requirements
- Legal/compliance signoff cho ingest log có PII customer (văn bản)
- Threat model 1 trang
- IdP team confirm OIDC client_id/secret/redirect/scopes
- Backup target chốt (NFS/MinIO/S3)
- Anthropic monthly budget cap (số cụ thể)
- TLS cert source (corp CA vs Let's Encrypt internal)
- PII format custom khách hàng (sample log)
- Oncall rota chốt

## Related files
- `docs/threat-model.md` — create
- `docs/pii-policy.md` — create
- `docs/oncall-runbook.md` — create skeleton (chi tiết ở Phase 06)

## Implementation steps
1. Gửi proposal PII ingest cho legal (kèm redaction policy hiện tại)
2. Họp IdP team — get OIDC config, test discovery endpoint
3. Hỏi infra team backup target + permission
4. Chốt Anthropic cap với finance
5. Hỏi infra team TLS cert source
6. Pull 100-500 log line từ 1 prod server → analyse PII format
7. Chốt oncall rota (2-3 admin)
8. Write `docs/threat-model.md` (1 trang) + `docs/pii-policy.md`

## Todo
- [ ] Legal signoff PII (văn bản)
- [ ] IdP OIDC config received
- [ ] Backup target xác nhận
- [ ] LLM budget cap number
- [ ] TLS cert source
- [ ] PII sample analyzed
- [ ] Oncall rota chốt
- [ ] threat-model.md + pii-policy.md committed

## Success criteria
- 8/8 unresolved question đã resolve
- Legal signoff document có file PDF/email lưu trữ
- Đủ thông tin để start Phase 01 không phải hỏi lại

## Risks
- Legal chậm 1-2 tuần → block toàn bộ plan. Mitigation: escalate sớm
- IdP team không có sẵn → fallback basic_auth, defer SSO sang sau go-live

## Security
- PII policy phải align với GDPR/Nghị định 13/2023 (data protection VN)
- Threat model cover: insider threat, VPN compromise, backup theft

## Next steps
Sang Phase 01 (prod VM) khi 8 question resolved.
