# Red-team: KB Chat Latency Quick Wins

**Target:** `plans/260724-0805-kb-chat-latency-quick-wins/`
**Date:** 2026-07-24
**Verdict:** Plan built on 3 unverified assumptions. Ship Phase 1 + 3, KILL Phase 2 until measured, REWORK Phase 4 to run FIRST.

---

## Severity ranking

### BLOCKER-1 — Backward workflow. Measure first, THEN optimize.
Plan runs Phase 1→2→3 then Phase 4 measures. If real bottleneck is DeepSeek streaming TTFT (~500ms) or LiteLLM proxy latency, ALL 3 optimizations combined save <300ms and target "40-60% cut" is fantasy. Brainstorm report `brainstorm-260724-0805-kb-scale-and-chat-speed.md` **does not exist** on disk — the "bottleneck = LLM multi-query + TLS + get" claim in plan.md line 5 is unsourced.
**Fix:** Phase 4 baseline MUST run before Phase 1. Reorder: 4a (baseline) → 1 → 4b → 2 → 4c → 3 → 4d.

### BLOCKER-2 — Phase 2 singleton `httpx.AsyncClient` likely broken in OpenWebUI sandbox.
Plan risk section admits this ("Function sandbox có thể reset module state"). Two real failure modes not addressed:
1. **Event loop binding.** `httpx.AsyncClient` locks to the loop it was created on. OpenWebUI executes tool calls via `asyncio.run()` or worker-scoped loop per request in some deployments → reused client raises `RuntimeError: attached to different loop` on 2nd call. This is not a "maybe" — it's how anyio/httpx works.
2. **Tool class re-instantiated per call.** `Tools()` is instantiated by OpenWebUI per invocation in current versions (see `__init__` pattern). Module-level cache survives, but if any request runs in a fresh worker process (uvicorn workers, gunicorn preload) the dict is empty → no reuse.
Plan's "mitigation" is "test thật, nếu confirmed reset → fallback plan là mcpo" — that's not mitigation, that's discovering the phase was worthless AFTER 20min of work.
**Fix:** BEFORE writing code, run a 5-min probe: add `print(id(_client_cache))` to a shim tool, invoke twice, compare IDs. If IDs differ or events-loop errors appear → KILL phase 2 outright; migrate to mcpo instead.

### HIGH-3 — Prompt tuning has no enforcement mechanism.
Rule "1 query only" is a request, not a constraint. DeepSeek/gpt-oss frequently ignore soft rules under uncertainty. Real fix = OpenAI `tool_choice="required"` + schema-level `maxItems` on a batched search tool, or reduce `onemcp_search` docstring exhortation ("Sinh 2-3 query candidate" is still in the docstring at line 71 of `onemcp-tools.py` — plan Phase 1 only edits the system prompt but the tool docstring will override, since LLMs weight tool schema highly).
**Fix:** Phase 1 MUST also edit the docstring in `onemcp-tools.py:66-79`. Otherwise prompt says one thing, tool schema says another → model picks tool schema. Also add per-model override for DeepSeek (plan mentions it as "if regress" — should be day-1).

### HIGH-4 — Trust-snippet silently degrades answer quality with no detection.
`ts_headline` 25 words often truncates root cause. User doesn't know they got a worse answer → satisfaction erodes invisibly. Plan success criterion "user không hỏi lại 'chi tiết hơn'" is non-measurable (user may just leave). No A/B, no eval set, no logging of `get` skip decisions.
**Fix:** Log every "snippet-only" decision + include `snippet_len` in tool result. Weekly manual review of 10 random chats to check answer completeness. Non-negotiable if this ships.

### HIGH-5 — 5s timeout too aggressive for cold path.
Postgres FTS after long idle (connection cold, buffer cache cold) can spike 3-5s on first query. Timeline: user opens chat first thing morning → onemcp_search cold path → 4s → `read=3.0s` timeout fires → false `kb_unavailable` → user's first impression of the day = broken. Loss of trust is unrecoverable in ops tools.
**Fix:** `read=6.0s` for search, `read=3.0s` for `get`. Or add warmup ping in a cron. Plan claims "OneMCP search bình thường < 300ms" without citing baseline — again, measure first.

### MEDIUM-6 — Phase 4 methodology statistically worthless.
5 questions × 1 run = N=5. LLM streaming TTFT variance is 20-40%. Median across 2 runs (mentioned in risks) is still N=10 across 5 conditions → wide CIs, undetectable 20% wins. Chrome DevTools stopwatch introduces human timing noise ±200ms.
**Fix:** 5 questions × 5 runs = N=25. Report median + IQR. Timing from `print()` inside tool + LiteLLM access log, not DevTools.

### MEDIUM-7 — Rollback story vague on prompt.
"Paste lại system-prompt-ops.md commit trước" — but the file lives in git AND in OpenWebUI DB as duplicated state. If admin edits prompt in UI without git commit → repo is out-of-sync → rollback restores wrong version. No mention of git commit-per-prompt-change discipline.
**Fix:** Add step: "commit prompt change to git BEFORE pasting to UI." Add drift check to Phase 4.

### NOISE-8 — Structured error `kb_unavailable` unenforced.
Prompt rule 7 says "ghi chú ngắn: OneMCP KB không khả dụng" — not `status: kb_unavailable`. Phase 3 introduces new JSON shape but doesn't update prompt to match. Model may render raw JSON to user.
**Fix:** Update prompt when Phase 3 lands.

### NOISE-9 — No cost analysis, no user-perception baseline.
Plan optimizes for latency without asking: does user care about 5→2s or 15→10s? Different UX class. No survey, no NPS. Also no LLM $/token savings estimate (fewer tool calls = fewer completion tokens).

---

## Phase verdict

| Phase | Verdict | Reason |
|---|---|---|
| 1 (prompt) | **MODIFY** | Also edit tool docstring line 71; add DeepSeek per-model override day-1 |
| 2 (httpx singleton) | **KILL** unless 5-min probe confirms sandbox persists state AND single event loop |
| 3 (timeout) | **MODIFY** | Raise `read` to 6s; split per-method; sync error shape with prompt |
| 4 (metrics) | **REWORK & MOVE FIRST** | Run baseline BEFORE phase 1; N=25 not N=5 |

---

## Unresolved questions

1. Does OpenWebUI Function module state persist across tool invocations, and if so, single event loop or per-request? (blocker for Phase 2)
2. Does `brainstorm-260724-0805-kb-scale-and-chat-speed.md` actually exist? Not found in `plans/reports/`. Plan's core premise is uncited.
3. What is DeepSeek TTFT baseline (LiteLLM → first token)? If ≥ 2s, this whole plan can only save ~1s absolute → below user perception threshold.
4. Is OneMCP `search` cold-path latency measured? 5s timeout is a guess.
5. Is `ts_headline` snippet quality acceptable — has anyone read 20 actual snippets from real KB entries?
6. Are OpenWebUI tool calls executed sequentially or in parallel? If sequential, 3 searches = 3× latency; if parallel, prompt tuning is smaller win.
