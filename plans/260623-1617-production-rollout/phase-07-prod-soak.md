# Phase 07 — Production Soak (1 tuần)

## Context
- [plan.md](plan.md) | [Brainstorm §Stage 7](../reports/brainstorm-260623-1617-production-rollout.md)

## Overview
- Priority: P1
- Status: pending
- Effort: 7 ngày (calendar, không full-time)
- Mục tiêu: Để 5 prod server forward log + LLM thật chạy 1 tuần. Daily check, tune drain3 + redaction, user feedback, cost review.

## Requirements
- Phase 04 + 05 + 06 done
- Daily check routine
- Sysadmin feedback session
- Bug/incident log

## Related files
- `infra/scripts/soak-check.sh` — already exists from MVP soak
- `docs/soak-report.md` — **create** end-of-week
- `evals/baseline-2026-XX.md` — weekly eval re-run

## Implementation steps
1. **Day 0**: confirm 5 server ingest, dashboard green, eval baseline run
2. **Daily (Day 1-6)**:
   - Run `soak-check.sh` — record numbers vào spreadsheet/markdown
   - Check Grafana dashboard
   - Review oncall alert (true positive vs noise)
   - Check post-ingest PII audit: phải 0 hit
   - Cost monitor: Anthropic spend so với daily projection
3. **Day 3 mid-soak review**:
   - Sysadmin feedback session 30 phút
   - Drain3 unmatched ratio: nếu > 5% → tune
   - Redaction false positive: nếu drop > 1% → tune regex
4. **Day 7 end-of-soak**:
   - Run eval harness lần nữa → compare baseline
   - Cost actual vs projected
   - Write `docs/soak-report.md`:
     - Volume actual per server
     - Top 10 alert fired
     - Top 5 incident + resolution
     - Eval score delta
     - Cost actual
     - Sysadmin feedback summary
     - Go/no-go cho rolling thêm server
5. Decision gate: GO production hay tiếp tục iterate?

## Todo
- [ ] Day 0 baseline numbers
- [ ] Daily check 6 ngày
- [ ] Mid-soak feedback session
- [ ] End-of-soak eval re-run
- [ ] soak-report.md committed
- [ ] Go/no-go decision

## Success criteria
- 0 PII leak qua 7 ngày
- Indexer lag < 5 phút sustained
- Chat p95 < 8s (real LLM)
- Eval score ≥ 75%
- Sysadmin feedback: "usable, accurate enough"
- Cost actual ≤ 1.2× projected
- 0 sev1 incident

## Risks
- Hidden PII pattern phát hiện soak → patch khẩn cấp Phase 03
- LLM cost > budget → cap drop chat quality, communicate finance
- Sysadmin không dùng → re-evaluate UX, có thể quay Phase 04 MVP fix
- Eval score thấp → tune prompt, expand template set, không go production

## Security
- Soak window là khi PII risk cao nhất (data thật mới ingest). Audit nhiều lần/ngày tuần đầu.
- Backup retention extend 60d trong soak để có rollback dài

## Next steps
- Go: Plan này → status `completed`. Move to ongoing operations.
- No-go: Spawn fix plan, iterate, soak lại

## Post-soak optional
- Phase 03.5 internal API adapters (Jira/GitLab/CMDB)
- Phase 08 MCP wire Claude Desktop production
- HA migration (Phase 07 MVP plan doc) khi chạm threshold
