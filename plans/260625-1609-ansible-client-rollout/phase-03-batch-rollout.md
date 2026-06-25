# Phase 03 — Batch rollout 10 → 50 → 200

**Status:** pending
**Priority:** P2 (depends on Phase 02 soak + P0 must-fix done)
**Effort:** 1-2 tuần (chính là soak time)

## Context links

- Phase 02: [phase-02-canary-1-srv.md](phase-02-canary-1-srv.md)
- P0 must-fix: [../reports/brainstorm-260625-1553-onelog-prod-readiness.md](../reports/brainstorm-260625-1553-onelog-prod-readiness.md) §3
- Observability plan: [../../260624-1417-observability-integration/plan.md](../../260624-1417-observability-integration/plan.md)

## Overview

Onboard 10 → 50 → 200 srv theo 3 batch tuần tự, mỗi batch soak ≥ 24h trước khi escalate. Monitor disk growth + indexer lag liên tục, abort nếu chạm threshold.

## Pre-req (hard gate)

- Phase 02 canary stable 7 ngày liên tiếp (mở rộng từ 24h soak).
- P0 must-fix #1 (backup offsite), #2 (monitor + alert healthcheck), #4 (retention VL), #5 (mock-logs disabled) DONE.
- P0 must-fix #3 (PII redact mail/hosting) DONE — verify lại bằng sample log từ canary.
- Disk capacity projection từ canary × N srv chấp nhận được, hoặc HA migration đã start.
- Inventory hoàn chỉnh: 200 host với IP + hostname + `ansible_user` chính xác.

## Implementation steps

### Step 1 — Batch 10

1. Populate `inventory.ini` group `batch_10` (10 host, ưu tiên 5 mail + 5 hosting để mix).
2. Dry-run:
   ```bash
   ansible-playbook playbook-onelog-client.yml -l batch_10 --ask-become-pass --check --diff --forks 10
   ```
3. Real run:
   ```bash
   ansible-playbook playbook-onelog-client.yml -l batch_10 --ask-become-pass --forks 10
   ```
4. Verify count:
   ```bash
   curl -s 'http://localhost:9428/select/logsql/query' \
     --data-urlencode 'query=onelog-ansible' \
     --data-urlencode 'start=10m' | jq -r '.[].host' | sort -u | wc -l
   ```
   Kỳ vọng = 11 (canary + 10).
5. Soak 24h: monitor `healthcheck.sh`, indexer lag, VL disk growth, alert silence.
6. Retry host fail:
   ```bash
   ansible-playbook playbook-onelog-client.yml -l <failed-host> --ask-become-pass
   ```

### Step 2 — Batch 50

Lặp lại step 1 với `-l batch_50`, `--forks 20`. Soak 48h thay 24h vì volume tăng đáng kể.

### Step 3 — Batch 200

Lặp lại với `-l batch_200`, `--forks 20`. Soak 72h. Monitor sát:
- VL disk %used (alert > 70%).
- Indexer NATS pending (alert > 5 min sustained).
- Vector dropped events (`vector top` hoặc `/metrics`).
- LLM token spend (nếu RAG agent đang chạy).

### Step 4 — Drift detection (NICE-TO-HAVE)

Cron weekly trên control node:
```cron
0 3 * * 0 cd /opt/ansible-onelog && ansible-playbook playbook-onelog-client.yml --check --diff > /var/log/ansible-drift.log 2>&1
```
Review log mỗi thứ Hai.

## Todo

- [ ] Pre-req gate verified (P0 done, canary 7d soak)
- [ ] Inventory `batch_10` populated
- [ ] Batch 10 deployed, 11 host verified VL
- [ ] Batch 10 soak 24h OK
- [ ] Inventory `batch_50` populated
- [ ] Batch 50 deployed, 61 host verified VL
- [ ] Batch 50 soak 48h OK
- [ ] Inventory `batch_200` populated
- [ ] Batch 200 deployed, 200+ host verified VL
- [ ] Batch 200 soak 72h OK
- [ ] (Optional) Cron drift detection enabled
- [ ] Capacity report: GB/ngày thực tế, % spec logserver dùng, ước lượng trigger HA migration

## Success criteria

- 200 srv onboard, ≥ 95% success rate per batch.
- Total batch 200 deploy < 15 phút wall-clock.
- Idempotent: `--check` toàn `all_onelog` = 0 change post-stable.
- Capacity benchmark documented: GB/ngày, indexer lag p99, VL disk growth rate.

## Risks

| Risk | Mitigation |
|---|---|
| Disk full giữa batch 200 soak | Alert disk > 70% → pause onboard, reduce retention hoặc add disk |
| Indexer lag spike khi onboard 50 srv mới cùng lúc | `serial: 20%` đã rolling. Nếu vẫn spike → scale indexer hoặc giảm forks |
| 1 sudo password sai cho 1 subset srv | Vault per-host `ansible_become_password`, hoặc skip subset rồi onboard sau |
| Mail spam wave trùng batch deploy → log burst | Schedule deploy off-peak (đêm/cuối tuần) |
| Vector buffer full client-side khi VL slow | Disk queue 500m đã set; alert client log nếu queue gần đầy (sau scope plan này) |

## Rollback

Per-host rollback đơn giản:
```bash
ansible <host> -a "rm /etc/rsyslog.d/90-forward-onelog.conf && systemctl restart rsyslog" --ask-become-pass
```

Hoặc playbook rollback (tạo `playbook-rollback.yml` nếu cần thường xuyên — YAGNI nay).

## Next

→ Plan kế tiếp: TLS app-layer port 6514 (defer per prod roadmap), Multi-tenant routing nếu cần.
