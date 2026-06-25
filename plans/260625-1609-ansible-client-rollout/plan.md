---
name: ansible-client-rollout
status: pending
created: 2026-06-25
updated: 2026-06-25
owner: trihd@inet.vn
blockedBy: []
blocks: []
relatedReports:
  - plans/reports/brainstorm-260625-1609-ansible-client-rollout.md
  - plans/reports/brainstorm-260625-1553-onelog-prod-readiness.md
relatedPlans:
  - plans/260624-1417-observability-integration
  - plans/260624-1642-rsyslog-json-ingest
---

# Plan: Ansible rollout cho OneLog clients

## Mục tiêu

Onboard 50-200 client server (Ubuntu, mail + shared hosting) gửi rsyslog → OneLog logserver bằng Ansible. KISS: 1 playbook + 1 inventory + 1 template Jinja, ~150 dòng YAML. Rollout canary → batch 10 → batch 50 → batch 200, có soak gate giữa batch.

## Context

- Stack logserver MVP đã pass smoke lab (`docs/deployment-guide.md`). Mạng LAN + OpenVPN, accept risk nội bộ.
- Script tay `infra/scripts/setup-rsyslog-client.sh` đã verify trên 2 srv lab → chuyển logic sang native Ansible task (idempotent, check mode, per-host template).
- Pre-req không bắt buộc nhưng STRONGLY RECOMMENDED: hoàn tất 5 must-fix P0 trong `plans/reports/brainstorm-260625-1553-onelog-prod-readiness.md` (đặc biệt backup offsite + monitoring + retention) trước khi onboard batch ≥ 10.
- Plan này không tự fix P0 — chỉ assume admin sẽ chạy P0 song song trước batch 10.

## Phases

| Phase | File | Status | Dependency |
|---|---|---|---|
| 01 | [phase-01-scaffold-ansible-skeleton.md](phase-01-scaffold-ansible-skeleton.md) | pending | — |
| 02 | [phase-02-canary-1-srv.md](phase-02-canary-1-srv.md) | pending | Phase 01 |
| 03 | [phase-03-batch-rollout.md](phase-03-batch-rollout.md) | pending | Phase 02 + P0 must-fix done |

## Out of scope (defer)

- Ansible Vault per-host sudo password (assume same password 200 srv; nếu khác → add task sau).
- Dynamic inventory (CMDB integration).
- TLS app-layer port 6514 (defer plan riêng theo prod roadmap).
- Drift detection cron weekly (NICE-TO-HAVE, không block onboarding).

## Success criteria

- Canary: 1 srv setup < 2 phút, smoke log landed VL < 10s.
- Batch 200: < 15 phút tổng, ≥ 95% success rate.
- `ansible-playbook --check` re-run = 0 change (idempotent verified).
- 1 lệnh verify trên logserver đếm host unique gửi log = match inventory count.
