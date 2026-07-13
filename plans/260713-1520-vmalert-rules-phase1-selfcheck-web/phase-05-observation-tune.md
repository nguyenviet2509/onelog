# Phase 05 — 24h observation + threshold tune

**Priority:** Post-deploy validation
**Effort:** ongoing 24h + 30m review
**Status:** pending
**Blocked by:** Phase 04 (trigger tests confirmed rules work)

## Mục tiêu

Quan sát 7 rules mới 24h → tune threshold nếu false positive spam / false negative silent.

## Steps

### 1. Baseline observation (T+24h)

```bash
# Trên LogServer
# Số lần mỗi rule mới fire trong 24h qua
curl -s http://localhost:9093/api/v2/alerts?filter=alertname%3D~%22HostLogSilent%7CVictoriaLogsSelfError%7CDockerContainerRestartLoop%7CWebServer4xxFlood%7CFileDescriptorExhaustion%7CPhpFpmWorkerExhaustion%7CLsphpSegfault%22 \
  | python3 -m json.tool

# Xem history qua vmalert
curl -s http://localhost:8880/api/v1/rules | python3 -c "
import json, sys
data = json.load(sys.stdin)
new_rules = ['HostLogSilent','VictoriaLogsSelfError','DockerContainerRestartLoop',
             'WebServer4xxFlood','FileDescriptorExhaustion','PhpFpmWorkerExhaustion','LsphpSegfault']
for g in data.get('data',{}).get('groups',[]):
    for r in g.get('rules',[]):
        if r.get('name') in new_rules:
            print(f\"{r['name']:35s} state={r['state']:10s} health={r.get('health','?')}\")
"
```

### 2. Tune decisions

| Rule | Threshold | Nếu fire quá nhiều (>3/day) | Nếu miss real event |
|---|---|---|---|
| HostLogSilent | 0 log/15m | Nâng window 30m | Không có case miss |
| VLSelfError | 5/2m | Nâng 10 | Hạ 3 |
| DockerRestartLoop | 5/5m | Nâng 10 | Hạ 3 |
| WebServer4xxFlood | 500/5m | **Cần baseline access log** → tính p95 rồi ×2 | Hạ theo baseline |
| FDExhaustion | 3/1m | Không nên fire >0 | Giữ nguyên |
| PhpFpmExhaust | 0/1m | Nếu real capacity issue → fix pool, không tune | Không thể miss (event rõ) |
| LsphpSegfault | 2/1m | Nếu real bug → fix, không tune | Hạ 1 |

### 3. Threshold tune commit

Nếu cần tune → sửa `infra/vmalert/rules.yml` → commit + push + reload (Phase 03 flow).

### 4. Docs sync

- [ ] Update [mockups/onelog-services-detail.html](../../mockups/onelog-services-detail.html) — rule count (nếu có block đếm)
- [ ] Update [docs/ops-cheatsheet.md](../../docs/ops-cheatsheet.md) — add note về 7 rules mới (1 dòng mỗi rule)
- [ ] Cân nhắc journal entry via `/ck:journal` nếu có insight từ observation

## Todo

- [ ] Wait 24h sau Phase 04 complete
- [ ] Query fire count từng rule
- [ ] Identify rules cần tune (>3 fire/day = spam candidate)
- [ ] Sync mockups + ops-cheatsheet
- [ ] Update plan.md status: `completed`
- [ ] Mark Phase 2 backlog gaps trong report chính

## Success

- 0 rules fire >5x/day mà không có sự cố thật
- 0 rules ở state `error` sau 24h
- Docs cập nhật sync với rules mới
- Nếu có rule bị disable/tune → ghi rõ lý do trong commit

## Next steps (Phase 2 backlog)

Khi phase 05 complete → kick off backlog items nếu prod đủ ổn:

1. Dead Man's Switch — set up healthchecks.io hoặc Uptime Kuma
2. Cert expiry probe (cron `openssl x509`)
3. Backup failure alert
4. Alertmanager inhibition rules (MysqlDown suppress children)
5. Runbook URL annotations
6. Baseline threshold retune sau 2 tuần data
