# OneMCP KB perf — trigger runbook

Threshold-driven optimization playbook. Không optimize preemptive. Đợi metric vượt ngưỡng → làm action tương ứng.

## Nguồn dữ liệu

- Instrumentation: `infra/openwebui/functions/onemcp-tools.py` — `print("[onemcp-tools] tool=X status=Y took=Zms")` mỗi `_rpc()` call
- Probe: `infra/openwebui/probe-onemcp-perf.sh` — cron 5min, grep `docker logs ragstack-openwebui --since 5m`, awk parse → JSON line
- Storage: `~/onemcp-perf.jsonl` trên onelog-source (host `vietnt`)
- Check: `tail -f ~/onemcp-perf.jsonl` hoặc `jq . ~/onemcp-perf.jsonl | tail -20`

Fields: `count`, `errors`, `p50_ms`, `p95_ms`, `avg_ms` cho window 5 phút.

## Trigger table

| Metric | Ngưỡng | Nghĩa | Action |
|---|---|---|---|
| `p95_ms` | > 300 | KB đang lớn dần, chưa lo | Ghi note, monitor thêm 1 tuần |
| `p95_ms` | > 800 | Bắt đầu chậm rõ | **Enable Redis cache** — plan mới, TTL 15min cho `search` key hash |
| `p95_ms` | > 2000 | FTS GIN scan quá tải | **pgvector semantic** — OneMCP P4 Part 2, embed backfill toàn KB |
| `errors > 5% count` | 3 window liên tiếp | OneMCP down hoặc network flaky | Check OneMCP nginx + backend logs; verify TLS cert expiry |
| `count/5min` | > 100 | High traffic bất thường | Kiểm tra có bot/loop nào lạm dụng không |
| `p95_ms` | > 10s | Total system pathology | **Escalate immediate** — có thể LiteLLM/OneMCP/DB đang halt |

## Snapshot check nhanh

```bash
# 24h latency trend
ssh onelog-source "tail -300 ~/onemcp-perf.jsonl | jq -r '[.ts, .count, .p50_ms, .p95_ms] | @tsv'"

# Error rate 6h
ssh onelog-source "tail -72 ~/onemcp-perf.jsonl | jq -s 'map(.errors) | add'"

# Peak p95 24h
ssh onelog-source "tail -300 ~/onemcp-perf.jsonl | jq -s 'max_by(.p95_ms) | .p95_ms'"
```

## Khi nào escalate lên full observability

Chuyển sang Vector + VictoriaMetrics + vmalert + Grafana khi:
- OneMCP Bridge migrate lên VPS (không còn lab throwaway)
- Team > 30 người, chat/day > 500
- `p95_ms > 300` xảy ra thường xuyên → cần alert real-time thay vì grep JSON

Trigger action: viết plan `plans/{date}-onemcp-perf-full-observability/`, wire Vector `docker_logs` source → VMLogs stream aggregation → vmalert rule per threshold row trên.

## Files liên quan

- Instrumentation: `infra/openwebui/functions/onemcp-tools.py` (block `_rpc` với `finally`)
- Probe: `infra/openwebui/probe-onemcp-perf.sh`
- Deploy location on lab: `~/bin/probe-onemcp-perf.sh` (host onelog-source)
- Cron: `crontab -l` on onelog-source, entry `*/5 * * * *`
- Log rolling: chưa có — nếu file > 100MB, thêm logrotate:
  ```
  ~/onemcp-perf.jsonl {
      weekly rotate 4 compress missingok notifempty
  }
  ```

## Related

- Brainstorm: [plans/reports/brainstorm-260724-0849-kb-observability-first.md](../plans/reports/brainstorm-260724-0849-kb-observability-first.md)
- Baseline: 6 chats, p50=41ms p95=85ms — establish floor 2026-07-24
- Superseded plan: [plans/260724-0805-kb-chat-latency-quick-wins/](../plans/260724-0805-kb-chat-latency-quick-wins/plan.md) — CANCEL, premature optimization
