# Brainstorm — KB observability-first (pivot from premature optimization)

**Date:** 2026-07-24 08:49
**Trigger:** User muốn "tối ưu tốc độ trước khi KB scale". Baseline 6 chats show LLM đã 1-query + RPC 40ms/chat → hypothesis "network là bottleneck" SAI.
**Supersedes:** [`plans/260724-0805-kb-chat-latency-quick-wins/`](../260724-0805-kb-chat-latency-quick-wins/plan.md) — CANCEL, không có problem để giải.

## Data cứng từ baseline

| Metric | Value | Verdict |
|---|---|---|
| Tool calls / chat | median 1 | LLM đã tự optimize |
| RPC latency p50 | 41ms | trivial |
| RPC latency p95 | 43ms | trivial |
| Status errors | 0% | healthy |
| KB size hiện tại | 6 entries | 3 năm nữa mới chạm ~3K |

## Vấn đề thực

User muốn **future-proof**, không có pain point hiện tại. Rủi ro: optimize mù = code chết, over-engineer làm hỏng cái đang chạy tốt.

## Approach chốt — Observability-first + cosmetic cleanup

### A. Observability (chính) — 2h effort
1. Chuyển `print()` → `logging.info` prefix `[onemcp-perf]` để Vector ship qua VictoriaLogs
2. VM scrape openwebui logs, parse metric `onemcp_rpc_duration_ms{tool="search|get|..."}` + `onemcp_rpc_errors_total`
3. vmalert rules (thresholds tương đối, tuning theo dữ liệu thật):
   - `search p95 > 300ms 5m` → warning (chưa lo)
   - `search p95 > 800ms 5m` → critical (bắt đầu cân Redis cache)
   - `search p95 > 2s 5m` → severe (pgvector semantic + shard)
   - `rpc_error_rate > 5% 3m` → critical (network/OneMCP down)
4. Grafana panel: median/p95/p99 per tool + calls/min + error rate
5. Runbook OneMCP KB `onelog-kb-scale-triggers`: table threshold → action

### B. Cosmetic cleanup (kèm) — 15 phút
1. Xoá docstring "Sinh 2-3 query candidate" (line 90 `onemcp-tools.py`) — LLM đang ignore rồi, để tránh future confuse
2. Xoá rule tương ứng system prompt
3. `TIMEOUT_SEC` 15→5s + structured error `{"status": "kb_unavailable", ...}` — chống chat freeze khi OneMCP down

### C. Skip (chống chỉ định)
- Persistent httpx client
- Timeout split per-method
- Snippet fallback logic
- Redis cache
- pgvector semantic

Tất cả sẽ trigger tự động khi observability alert kích.

## Success criteria

- Grafana panel show latency histogram, live
- vmalert 3 rule kích khi test threshold (fault injection)
- Runbook link được từ alert (Alertmanager annotation)
- Codebase clean, không có dead optimization code

## Effort summary

- A observability: 2h
- B cleanup: 15min
- **Total: 2h 15min** (thay vì 130 phút của plan cũ, mà plan cũ giải problem không tồn tại)

## Unresolved

- Ngưỡng 300/800/2000ms có phù hợp không? → tune sau khi có 1 tháng data thật
- Có cần alert riêng cho từng dept/service không? → defer, chỉ 1 vector VP/user hiện tại
- Runbook viết chi tiết đến đâu? → 1-page, chỉ table trigger → action
