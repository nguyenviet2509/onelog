---
name: production-rollout
status: cancelled
cancelledAt: 2026-06-23
cancelReason: Audience thực tế = 5 ops nội bộ + Claude Team có sẵn → MCP-only thay thế production model này. Web UI + SSO OIDC + LLM key server-side không cần. Xem plans/reports/brainstorm-260623-1644-ops-mcp-only-decision.md.
created: 2026-06-23
updated: 2026-06-23
owner: trihd@inet.vn
blockedBy: []
blocks: []
supersededBy: plans/260623-2041-mcp-only-rollout
relatedReports:
  - plans/reports/brainstorm-260623-1617-production-rollout.md
  - plans/reports/brainstorm-260623-1644-ops-mcp-only-decision.md
relatedPlans:
  - plans/260622-1056-rag-logserver-victorialogs
---

# Plan: Production Rollout onelog

## Mục tiêu
Chuyển onelog từ PoC single-node (logserver-01 + 2 mock client) sang **production thật**: VM prod mới + onboard 5 server Ubuntu phục vụ khách hàng. Thay anonymous session bằng SSO OIDC, dùng LLM key thật, hardening PII/redaction, full ops readiness.

## Context
- Brainstorm: [brainstorm-260623-1617-production-rollout.md](../reports/brainstorm-260623-1617-production-rollout.md)
- Base MVP: [260622-1056-rag-logserver-victorialogs](../260622-1056-rag-logserver-victorialogs/plan.md) — MVP scaffolded, soak đang chạy
- Scale: 5 prod server Ubuntu/Debian, 5-20 GB/ngày tổng
- Users: 2-3 sysadmin, internal VPN-only ban đầu
- PII: data customer thật → strict redaction + legal signoff
- Auth: Phase 09 brought forward (SSO OIDC corp IdP)
- LLM: Anthropic key + OpenAI embedding, budget cap mandatory

## Phases

| # | Phase | Status | Dep |
|---|---|---|---|
| 00 | [Pre-flight gating (legal + threat model + IdP confirm)](phase-00-preflight.md) | pending | — |
| 01 | [Prod VM hardened + DNS + TLS + backup](phase-01-prod-vm.md) | pending | 00 |
| 02 | [SSO OIDC + real auth + role-based access](phase-02-sso-auth.md) | pending | 01 |
| 03 | [PII redaction hardening + legal-grade policy](phase-03-pii-hardening.md) | pending | 01 |
| 04 | [Client onboarding script + pilot + roll out 5 server](phase-04-client-onboarding.md) | pending | 01 |
| 05 | [Real LLM + Phase 05 eval harness + cost cap](phase-05-real-llm-eval.md) | pending | 02 |
| 06 | [Ops readiness: metrics + Grafana + oncall + restore drill](phase-06-ops-readiness.md) | pending | 01 |
| 07 | [Production soak 1 tuần + iterate](phase-07-prod-soak.md) | pending | 04, 05, 06 |

## Critical Path
00 → 01 → (02 ‖ 03 ‖ 04) → (05 ‖ 06) → 07

Phase 02 và 03 song song sau 01. Phase 04 song song với 02+03 nếu nhân lực đủ. Phase 05 chạy được sau 02 xong. Phase 06 song song 05. Phase 07 soak sau khi 04+05+06 đều xong.

## Timeline
- Phase 00: 1-2d (block bởi legal)
- Phase 01: 2-3d
- Phase 02: 3-5d
- Phase 03: 2-3d
- Phase 04: 2-3d (sau 1 server pilot 24h)
- Phase 05: 2-3d
- Phase 06: 2-3d
- Phase 07: 7d
- **Total**: 3-4 tuần

## Success Criteria
- 5/5 server forward log ổn định ≥ 7 ngày
- PII post-ingest audit: 0 leak qua 7 ngày
- SSO login + role-based access work end-to-end
- LLM chat p95 < 8s với key thật, citation 100% valid
- Backup restore drill pass
- Cost tuần đầu trong budget cap

## Risks
| # | Risk | Sev | Mitigation |
|---|---|---|---|
| 1 | Legal signoff block | High | Đẩy Phase 00 ngay, ưu tiên cao nhất |
| 2 | IdP team chậm | Med | Fallback Caddy basic_auth tạm |
| 3 | PII leak runtime | **Critical** | Post-ingest audit daily + fail-closed |
| 4 | LLM cost runaway | High | Anthropic console hard cap (mandatory) |
| 5 | Backup restore chưa drill | High | Phase 06 gating, không go-live nếu fail |
| 6 | Disk overflow | Med | Monitor + extend retention sau soak |

## Unresolved questions
Xem [brainstorm report](../reports/brainstorm-260623-1617-production-rollout.md) §"Unresolved questions" — 8 câu cần resolve trong Phase 00.
