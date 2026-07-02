# Phase 04 — Vietnamese Benchmark (20 queries × 4 providers)

## Context
- Brainstorm: [../reports/brainstorm-260701-1544-llm-provider-abstraction.md](../reports/brainstorm-260701-1544-llm-provider-abstraction.md)
- Depends: Phase 1 (agent LiteLLM) + Phase 2 (proxy)
- Citation validator: [agent/src/agent/agent_loop.py:110](../../agent/src/agent/agent_loop.py#L110)

## Overview
- **Priority:** Medium
- **Status:** pending
- **Description:** Chạy 20 query VI thực tế trên 4 provider (Claude, GPT, Gemini, DeepSeek). Đo cost, latency, tool-call success, VI quality. Publish matrix để chọn default provider cho prod.

## Key insights
- Provider quality VI ≠ quality EN. DeepSeek trên paper mạnh nhưng VI yếu hơn kỳ vọng.
- Tool-use fidelity là gate quan trọng — nếu Gemini malformed args > 10%, không dùng làm default.
- Cost measurement: dùng LiteLLM cost log (Phase 2 output).

## Requirements

### Functional
- 20 query VI cover 4 loại: (a) template search, (b) LogsQL query, (c) time-series stats, (d) troubleshooting narrative.
- Chạy mỗi query × 4 provider = 80 runs.
- Log: latency, tokens_in/out, cost, tool_calls_made, tool_call_errors, citation_valid.
- Manual VI quality grade 1-5 (native speaker rate).

### Non-functional
- Total run time < 2 giờ.
- Cost total < 500K VND (đủ để dùng Claude 20 lần).

## Related code files

### Create
- `agent/tests/benchmark/queries-vi.json` — 20 query VI + expected tool.
- `agent/tests/benchmark/run-benchmark.py` — orchestration script.
- `plans/260701-1544-llm-provider-abstraction/benchmark-results.md` — kết quả (sau khi chạy).

### Modify
- Không có.

## Implementation steps

### Step 1 — Query set
20 query đại diện workload thực. Ví dụ:
```json
[
  {"id": "q01", "category": "template_search", "query": "mysql có lỗi gì gần đây?", "expected_tool": "search_log_templates"},
  {"id": "q02", "category": "template_search", "query": "server srv-01 báo lỗi gì trong 1 giờ qua?", "expected_tool": "search_log_templates"},
  {"id": "q03", "category": "logsql_query", "query": "đếm số lỗi ERROR trong service nginx hôm nay", "expected_tool": "query_victorialogs"},
  {"id": "q04", "category": "stats", "query": "top 5 service phát nhiều log nhất tuần này", "expected_tool": "query_victorialogs"},
  {"id": "q05", "category": "troubleshoot", "query": "tại sao database bị disconnect liên tục?", "expected_tool": "search_log_templates"},
  ...
]
```

Yêu cầu: 5 query mỗi category. Query từ ops team log thực tế (anonymize nếu có PII).

### Step 2 — Runner script
```python
# agent/tests/benchmark/run-benchmark.py
import asyncio, json, time, csv
from agent.llm_client import LLMClient
from agent.agent_loop import run_agent
import os

# [RT-F7] Claude phải benchmark 2 mode để so sánh apple-to-apple với provider
# không có prompt caching. Cost -88% Gemini vs Claude là số RAW; sau khi bật
# prompt cache Claude thực tế cost thấp hơn ~70% raw.
MODELS = [
    "anthropic/claude-sonnet-4-5",              # no cache
    "anthropic/claude-sonnet-4-5+cache",        # LiteLLM cache_control auto
    "openai/gpt-4.1-mini",
    "gemini/gemini-2.5-flash",
    "deepseek/deepseek-chat",
]

async def run_one(query_id, query, model):
    # [RT-F14] Pydantic Settings singleton KHÔNG hot-reload khi set os.environ
    # sau import. Phải chạy subprocess per provider để settings init lại.
    # Runner này inline chỉ dùng khi refactor LLMClient accept model param override.
    os.environ["LLM_MODEL"] = model.replace("+cache", "")
    os.environ["LLM_ENABLE_PROMPT_CACHE"] = "true" if "+cache" in model else "false"
    events = []
    t0 = time.time()
    async for ev in run_agent(query):
        events.append(ev)
    latency = time.time() - t0

    tool_calls = [e for e in events if e["type"] == "tool_call"]
    tool_errors = [e for e in events if e["type"] == "tool_result"
                   and isinstance(e["output"], dict) and "error" in e["output"]]
    answer = next((e for e in events if e["type"] == "answer"), None)

    return {
        "query_id": query_id,
        "model": model,
        "latency_s": round(latency, 2),
        "tool_calls": len(tool_calls),
        "tool_errors": len(tool_errors),
        "citation_valid": bool(answer and answer.get("citations")),
        "answer_text": answer.get("text", "") if answer else "",
    }

async def main():
    with open("queries-vi.json") as f:
        queries = json.load(f)

    results = []
    for q in queries:
        for m in MODELS:
            r = await run_one(q["id"], q["query"], m)
            r["category"] = q["category"]
            results.append(r)
            print(f"{q['id']} × {m}: latency={r['latency_s']}s citation={r['citation_valid']}")

    with open("benchmark-raw.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=results[0].keys())
        w.writeheader()
        w.writerows(results)

if __name__ == "__main__":
    asyncio.run(main())
```

### Step 3 — Cost extraction
Sau khi chạy xong, lấy cost từ LiteLLM logs:
```bash
docker compose logs litellm-proxy | jq -c 'select(.event == "request_complete")
  | {model, cost, tokens_in: .usage.prompt_tokens, tokens_out: .usage.completion_tokens}' \
  > benchmark-costs.jsonl
```

Join `benchmark-raw.csv` + `benchmark-costs.jsonl` bằng timestamp/query_id.

### Step 4 — Manual VI quality grading
Sheet CSV, cột: `query_id, model, answer_text, quality_score (1-5), notes`.
2 native speaker chấm độc lập → average.

Rubric:
- 5: đúng, đầy đủ, tự nhiên
- 4: đúng, tự nhiên, thiếu 1 chi tiết nhỏ
- 3: đúng ý nhưng gượng, hoặc dịch máy
- 2: sai chi tiết quan trọng
- 1: hoàn toàn sai / hallucinate

### Step 4b — [RT-F8] Benchmark qua MCP path (user-facing thực)
Runner ở Step 2 chạy trực tiếp LiteLLM API → không đại diện path OpenWebUI. Thêm 1 vòng benchmark qua MCP:

```python
# scripts/benchmark-mcp-path.py — gọi OpenWebUI REST API
import httpx
# OpenWebUI có endpoint /api/chat/completions OpenAI-compat với MCP tool inject
r = httpx.post("http://app.local/webui/api/chat/completions",
    headers={"Authorization": f"Bearer {USER_JWT}"},
    json={"model": model_alias, "messages": [...], "tools_enabled": True})
```

Đo cùng metric (latency, tool_calls, citation_valid) nhưng qua stack thực tế. So sánh với direct-LiteLLM để phát hiện overhead + tool-schema translation loss.

### Step 5 — Publish matrix
File `benchmark-results.md`:

```markdown
# Benchmark Results — 20 VI queries × 4 providers

| Provider | Avg latency | Cost/20q (VND) | Tool success | Citation valid | VI quality avg |
|---|---|---|---|---|---|
| claude-sonnet-4-5 | ... | ... | ...% | ...% | ... |
| gpt-4.1-mini | ... | ... | ...% | ...% | ... |
| gemini-2.5-flash | ... | ... | ...% | ...% | ... |
| deepseek-chat | ... | ... | ...% | ...% | ... |

## Recommendation
- **Prod default:** {provider}
- **Fallback #1:** {provider}
- **Premium (complex queries):** {provider}
```

## Todo list
- [ ] Chuẩn bị 20 query VI từ log thực tế (5/category)
- [ ] Verify Phase 1 + Phase 2 ready + có key cho 4 provider
- [ ] **[RT-F14]** Refactor runner dùng subprocess per provider hoặc `LLMClient(model=...)` override
- [ ] Chạy `run-benchmark.py` direct-LiteLLM, thu `benchmark-raw.csv`
- [ ] **[RT-F8]** Chạy `benchmark-mcp-path.py` qua OpenWebUI, thu `benchmark-mcp.csv`
- [ ] **[RT-F7]** So sánh Claude no-cache vs Claude+cache — cost thực tế Anthropic
- [ ] Extract cost từ LiteLLM log
- [ ] Manual VI grading (2 người, 40 phút mỗi người)
- [ ] Viết `benchmark-results.md` với matrix + recommendation
- [ ] Update `plan.md` với provider default đã chọn
- [ ] Update `.env.example` với `LLM_MODEL` default mới (nếu khác Claude)

## Success criteria
- 4 provider chạy hết 20 query không error hạ tầng (LiteLLM / agent crash).
- Matrix có đủ 5 cột metric cho mỗi provider.
- Recommendation rõ ràng: chọn 1 provider default có tool_success ≥ 95% VÀ VI quality avg ≥ 4.0.
- Cost saving vs Claude baseline được quantify bằng % cụ thể.

## Risk assessment

| Rủi ro | Mitigation |
|---|---|
| Provider rate limit khi chạy 80 request liên tiếp | Delay 2s giữa các call; nếu 429 → retry sau 30s |
| Cost blow up khi Claude trả turn dài | Set `llm_max_tokens=4096`, budget cap qua LiteLLM virtual key |
| VI grader bias | 2 grader độc lập, so sánh, giải quyết bất đồng qua discussion |
| Tool errors gây citation false negative | Log tool_result payload cho manual inspect nếu score bất thường |

## Security
- Query VI có thể chứa PII (server names, service names). Anonymize trước khi commit `queries-vi.json` git.
- Answer log có thể leak infra internals — không commit `benchmark-raw.csv` public.

## Next steps
- Nếu Gemini thắng → update `LLM_MODEL` default trong Phase 1 + Phase 5 docs.
- Nếu không có provider nào đạt 95% tool_success + 4.0 VI → giữ Claude default, note rủi ro trong docs.
