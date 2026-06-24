# Phase 05 — Real LLM + Eval Harness

## Context
- [plan.md](plan.md) | [Brainstorm §Stage 5](../reports/brainstorm-260623-1617-production-rollout.md)
- Unblocks Phase 05 MVP plan (deferred do thiếu LLM key)

## Overview
- Priority: P1
- Status: pending
- Effort: 2-3 ngày
- Mục tiêu: Tắt mock, dùng Anthropic + OpenAI key thật. Re-embed Qdrant. Set hard budget cap. Eval harness 20 case → baseline metric.

## Requirements
- Anthropic API key + monthly budget cap (Phase 00)
- OpenAI API key cho embedding
- Anthropic console set hard limit + alert
- Phase 05 MVP eval harness implement đầy đủ

## Related files
- `infra/.env` — set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `LLM_MOCK=false`, `EMBED_MOCK=false`
- `agent/src/agent/llm_client.py` — verify path non-mock work
- `agent/src/agent/embed.py` — verify OpenAI ada call work
- `evals/` — **create new dir**
- `evals/cases/*.yaml` — 20 case files
- `evals/run.py` — harness runner
- `evals/report.py` — Markdown report generator
- `agent/src/agent/cost_tracker.py` — **create** (token count + USD/day per user)
- `web/src/app/admin/cost/page.tsx` — **create** (basic cost dashboard)

## Implementation steps
1. Set keys trong `.env` (production)
2. Anthropic console: hard limit monthly cap + 50%/80%/100% alert email
3. Re-embed Qdrant:
   - Backup current collection (mock embed)
   - Drop + recreate collection
   - Indexer pick up từ NATS lại với `EMBED_MOCK=false` → embed thật bằng OpenAI
   - **Hoặc** backfill từ Drain3 state file: replay template embed
4. Smoke test chat: 5 câu hỏi realistic
5. Citation validator check: rate hợp lệ phải > 95%
6. Write 20 case YAML (gold standard):
   - 5 SSH brute force, 5 DB error, 5 app exception, 5 infra (disk/network)
   - Mỗi case: query + expected templates (sha) + expected citation host
7. `evals/run.py`:
   - Loop cases → call agent API → score answer
   - Score: contains expected template? citation valid? not hallucinated?
   - Output JSON results
8. `evals/report.py`: Markdown summary table
9. Run baseline → commit `evals/baseline-2026-06.md`
10. `agent/src/agent/cost_tracker.py`:
    - Hook vào Anthropic response → count input/output tokens
    - Persist `usage_log` table Postgres (user_id, model, tokens_in, tokens_out, cost_usd, timestamp)
    - Daily aggregate → expose `/api/admin/cost`
11. `web/src/app/admin/cost/page.tsx`: bảng cost 30 ngày + user top spender

## Todo
- [ ] Keys set + hard cap configured Anthropic console
- [ ] Qdrant re-embed done, smoke 5 query work
- [ ] 20 eval cases written
- [ ] evals/run.py + report.py
- [ ] Baseline run + report committed
- [ ] cost_tracker.py + usage_log table
- [ ] /admin/cost page

## Success criteria
- Smoke 5 query: 5/5 citation valid, p95 < 8s
- Eval baseline: ≥ 70% case correct (target 80% sau tune)
- Cost dashboard reflect actual spend Anthropic console
- Hard cap trigger: artificial test spike → alert fire

## Risks
- Re-embed tốn $10-50 cho hết Qdrant collection → factor vào budget
- Anthropic 429 rate limit → backoff đã có trong `llm_client.py`
- Embedding cost lúc indexer chạy continuous → batch + cache theo template sha (đã có ở indexer)
- LLM hallucination rate cao trên prod data → Phase 07 soak tune prompt

## Security
- API key trong `.env` mode 600
- Cost data có thể bị abuse → `/admin/cost` role=admin only
- Per-user quota để tránh 1 user đốt hết budget (defer nếu user count nhỏ)

## Next steps
- Phase 07 soak: monitor eval score weekly
- Per-user quota implement nếu cost runaway
