# Phase 01 — Scaffold Ansible skeleton

**Status:** pending
**Priority:** P1 (block phase 02)
**Effort:** 0.5d

## Context links

- Brainstorm: [../reports/brainstorm-260625-1609-ansible-client-rollout.md](../reports/brainstorm-260625-1609-ansible-client-rollout.md)
- Existing script tham chiếu: `infra/scripts/setup-rsyslog-client.sh`

## Overview

Tạo skeleton `infra/ansible/` (4 file YAML + 1 README) trong repo. Chưa chạy production, chỉ syntax-check + dry-run trên local. Native Ansible modules (apt/template/systemd/wait_for), KHÔNG wrap shell script cũ.

## Requirements

- Skeleton placed at `infra/ansible/` (cùng repo, không tách).
- `ansible-playbook --syntax-check` pass.
- `ansible-lint` (nếu cài) clean hoặc explainable warnings.
- README đủ để người mới chạy được canary trong < 5 phút.

## Files to create

| File | Purpose |
|---|---|
| `infra/ansible/ansible.cfg` | forks=20, pipelining, ControlPersist, fact cache |
| `infra/ansible/inventory.ini` | Groups `canary`, `batch_10`, `batch_50`, `batch_200`, parent `all_onelog`. Stub host placeholders + group vars (`log_server_ip`, `log_server_port`, `rsyslog_queue_maxdisk`) |
| `infra/ansible/playbook-onelog-client.yml` | 6 task chính: assert Ubuntu, apt install rsyslog+chrony, enable chrony, backup conflicting confs, deploy template (validate `rsyslogd -N1`), wait_for port, smoke logger. Handler restart rsyslog. `serial: 20%`, `max_fail_percentage: 10`, `any_errors_fatal: false` |
| `infra/ansible/templates/90-forward-onelog.conf.j2` | Jinja port của `rsyslog-forward.conf` với 3 var: `log_server_ip`, `log_server_port`, `rsyslog_queue_maxdisk` |
| `infra/ansible/README.md` | 5 lệnh canary/batch, cách thêm host vào inventory, verify command trên logserver |

## Implementation steps

1. Tạo cấu trúc thư mục `infra/ansible/{templates}`.
2. Viết `ansible.cfg` per design trong brainstorm §6.
3. Viết `inventory.ini` với placeholder host (vd `srv-mail-pilot ansible_host=10.0.1.10`) — admin sẽ thay IP thật sau.
4. Viết template Jinja từ `infra/clients/rsyslog-forward.conf` hiện có, thay constant bằng var.
5. Viết playbook YAML theo design brainstorm §4.
6. Viết README ngắn (< 60 dòng): pre-req (ssh key, sudo password), 5 lệnh chạy canary/batch_10/batch_50/batch_200, verify command logserver, troubleshooting (sudo password mismatch → vault note, port 6514 blocked → ufw note).
7. `ansible-playbook --syntax-check playbook-onelog-client.yml` pass.
8. `ansible-playbook --check --diff -l canary --connection=local` trên localhost (host placeholder) — chỉ verify task list chạy, không touch system thật.

## Todo

- [ ] `mkdir -p infra/ansible/templates`
- [ ] Write `ansible.cfg`
- [ ] Write `inventory.ini` (stub host)
- [ ] Write `templates/90-forward-onelog.conf.j2`
- [ ] Write `playbook-onelog-client.yml`
- [ ] Write `README.md`
- [ ] `ansible-playbook --syntax-check` pass
- [ ] Commit (`feat(infra): ansible skeleton for onelog client rollout`)

## Success criteria

- 5 file trên repo, syntax-check pass.
- README đủ tự-document cho người mới.
- KHÔNG có chạy thật trên host nào (chưa có inventory thật).

## Risks

| Risk | Mitigation |
|---|---|
| `rsyslogd -N1` validate trên template ko có `%`-placeholder thật → false fail | Validate chạy trên file đã render Ansible, không phải `.j2` raw → OK |
| Ansible chưa cài trên control node | README liệt kê `apt install ansible` step |

## Next

→ Phase 02 (Canary 1 srv).
