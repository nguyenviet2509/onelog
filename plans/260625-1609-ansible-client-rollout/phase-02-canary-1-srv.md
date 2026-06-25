# Phase 02 — Canary 1 srv

**Status:** pending
**Priority:** P1 (block phase 03)
**Effort:** 0.5d (chạy < 30 phút, soak 24h)

## Context links

- Phase 01: [phase-01-scaffold-ansible-skeleton.md](phase-01-scaffold-ansible-skeleton.md)
- Brainstorm: [../reports/brainstorm-260625-1609-ansible-client-rollout.md](../reports/brainstorm-260625-1609-ansible-client-rollout.md) §3, §7

## Overview

Onboard 1 srv pilot ít traffic nhất (mail server nội bộ) bằng playbook Phase 01. Soak 24h, verify VL ingest + disk growth logserver + PII redaction OK trên log thật. Iterate playbook/template nếu cần.

## Pre-req

- Phase 01 done.
- 1 srv pilot xác định (ưu tiên mail server nội bộ thấp traffic).
- SSH key control node → pilot deployed.
- Sudo password biết.
- Firewall egress port 6514 từ pilot → logserver mở.
- Logserver healthy (`bash infra/scripts/healthcheck.sh` xanh).

## Implementation steps

1. Update `inventory.ini` group `canary`: thêm host pilot thật (`ansible_host=<IP>`, `ansible_user=<user>`, `onelog_role=mail`).
2. Dry-run:
   ```bash
   cd infra/ansible
   ansible-playbook playbook-onelog-client.yml -l canary --ask-become-pass --check --diff
   ```
   Review diff `/etc/rsyslog.d/90-forward-onelog.conf` đúng kỳ vọng, không có task lạ.
3. Real run:
   ```bash
   ansible-playbook playbook-onelog-client.yml -l canary --ask-become-pass
   ```
4. Verify trên logserver:
   ```bash
   curl -s 'http://localhost:9428/select/logsql/query' \
     --data-urlencode 'query=onelog-ansible host:<pilot-hostname>' \
     --data-urlencode 'start=5m' | jq .
   ```
   Kỳ vọng ≥ 1 record `service=onelog-ansible`.
5. Sample 100 dòng log thật từ pilot (`logger`-emitted + Postfix/Dovecot tự nhiên):
   ```bash
   curl -s 'http://localhost:9428/select/logsql/query' \
     --data-urlencode 'query=host:<pilot-hostname>' \
     --data-urlencode 'limit=100' | jq -r '.[]._msg'
   ```
   Grep PII patterns: `@`, IP regex, `Bearer `, password keyword. Nếu leak → update VRL redact (out-of-scope plan này, tạo issue riêng).
6. Idempotency re-run:
   ```bash
   ansible-playbook playbook-onelog-client.yml -l canary --ask-become-pass --check
   ```
   Kỳ vọng `0 changed`.
7. Disk growth check sau 24h soak:
   ```bash
   df -h /opt/onelog/infra/victorialogs
   docker exec onelog-victorialogs du -sh /storage
   ```
   Ghi baseline GB/h từ 1 srv → extrapolate sang batch.

## Todo

- [ ] Inventory `canary` populated với host thật
- [ ] `--check --diff` review OK
- [ ] Real run pass
- [ ] VL query verify smoke log
- [ ] Sample 100 dòng log thật, grep PII (báo nếu leak)
- [ ] Idempotent re-run `--check` = 0 change
- [ ] 24h soak: VL disk growth measured, indexer lag < 1 phút
- [ ] Document GB/h baseline trong plan.md

## Success criteria

- Smoke log landed VL < 10s sau run.
- 24h soak: 0 alert healthcheck, VL disk growth tuyến tính + projection 500 GB/ngày khả thi với spec hiện tại HOẶC flag scale issue ngay.
- 0 PII leak trên 100 dòng sample.
- Idempotent: `--check` re-run 0 change.

## Risks

| Risk | Mitigation |
|---|---|
| Postfix log có PII Vector redact chưa cover | Sample log → tạo issue update VRL; block phase 03 cho đến khi fix |
| Pilot disk growth project ra > spec logserver | Re-evaluate retention từ 30d → 14d hoặc trigger HA roadmap §1 sớm |
| `--check --diff` ra task lạ | Review playbook, fix Phase 01 trước khi proceed |
| SSH timeout / sudo password sai | Verify SSH thủ công `ssh pilot 'sudo -n true'` trước khi chạy Ansible |

## Next

→ Phase 03 (batch rollout) khi soak 24h pass + P0 must-fix monitoring/backup done.
