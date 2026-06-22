# Phase 05 — Eval harness + Prompt tuning

## Context
- Plan: [plan.md](plan.md)
- Design: [brainstorm report §11, §12](../reports/brainstorm-260622-1056-rag-logserver-victorialogs.md)

## Overview
- Priority: P0 (gate trước khi handover sysadmin)
- Status: pending
- Mục tiêu: Bộ 20 test case canonical, harness chạy auto, đo accuracy/latency/cost/citation; iterate prompt cho đến đạt SLA.

## Requirements
- 20 test case cover: mail down, ssh brute force, disk full, OOM, cert expire, postfix queue, dns timeout, nginx 5xx spike, mysql slow query, kernel panic, fail2ban triggered, backup fail, ntp drift, raid degraded, oom-killer, ssl handshake fail, smtp rate limit, dovecot auth fail, journal corruption, network flap.
- Mỗi case: prompt + expected service/host/time_window + expected key findings
- Manual scoring rubric: correct/partial/wrong + citation valid y/n

## Architecture
```
eval/
├── cases.yaml          (20 cases)
├── runner.py           (gọi agent /chat, collect response)
├── scorer.py           (semi-auto + human review CLI)
├── report.py           (markdown report per run)
└── fixtures/           (inject log mẫu nếu cần synthetic)
```

## Related Code Files
Create:
- `eval/pyproject.toml`
- `eval/cases.yaml`
- `eval/src/eval/runner.py`
- `eval/src/eval/scorer.py`
- `eval/src/eval/report.py`
- `eval/src/eval/fixtures/inject_logs.py`
- `eval/results/` (output dir)
- `agent/src/agent/prompts/system.md` (iterate)

## Implementation Steps
1. Soạn `cases.yaml` 20 case theo schema:
   ```yaml
   - id: mail-001
     prompt: "Mail server đang chậm, check giúp"
     expected:
       service: postfix
       window: last_30m
       key_findings: ["queue size > 1000", "smtp timeout"]
       must_cite: true
   ```
2. `fixtures/inject_logs.py`: với case chưa có log thật, inject log synthetic vào VictoriaLogs (HTTP POST) để eval reproducible
3. `runner.py`: với mỗi case POST agent `/chat`, lưu response + tool_calls + latency + token + cost
4. `scorer.py`:
   - auto check: citation regex match `[\w\-]+:[\w\-\.]+:\d{4}`, service match expected
   - human CLI: hiển thị prompt/response/expected → input `correct|partial|wrong` + note
5. `report.py`: generate markdown — pass rate, p50/p95 latency, total cost, breakdown per case, regression vs prev run
6. Iterate:
   - Run baseline → report
   - Sửa system prompt (citation rule, format, examples)
   - Sửa tool description (LLM gọi đúng tool hơn)
   - Re-run, target ≥ 80% correct, < 2% no-citation
7. Lock prompt vào git, tag version `prompt-v1.0`

## Todo
- [ ] Soạn 20 case YAML
- [ ] Inject synthetic logs cho case thiếu data
- [ ] Runner script
- [ ] Scorer auto + human CLI
- [ ] Report generator
- [ ] Baseline run + report
- [ ] Iterate prompt ≥3 vòng
- [ ] Tag prompt-v1.0
- [ ] Doc eval-guide.md

## Success Criteria
- ≥ 80% case "correct"
- ≤ 10% "wrong"
- 100% case có citation (validator pass) hoặc explicit "không đủ data"
- p95 latency 1-turn < 8s, multi-turn < 15s
- Cost tổng 20 case < $1
- Drain3 unmatched_ratio < 5% trong giai đoạn eval

## Risks
- LLM non-determinism → chạy 3 lần, lấy majority
- Synthetic log không realistic → ưu tiên log thật từ production
- Prompt over-fit 20 case → giữ 5 case "hold-out" không tune

## Security
- Eval log có thể chứa PII fixture → fixture phải synthetic, không dùng data thật
- Results không commit nếu chứa nội dung nhạy cảm

## Next Steps
- Pass eval → handover sysadmin pilot 1 tuần
- Phase 07 HA roadmap sau khi MVP ổn
