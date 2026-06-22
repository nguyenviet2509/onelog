# Phase 03 — RAG Agent service (FastAPI + LangGraph + Claude Sonnet tool-use)

## Context
- Plan: [plan.md](plan.md)
- Design: [brainstorm report §4](../reports/brainstorm-260622-1056-rag-logserver-victorialogs.md)

## Overview
- Priority: P0
- Status: pending
- Mục tiêu: Service HTTP nhận query free-form, chạy agent loop với Claude Sonnet + tools (Qdrant search, LogsQL query, summarize, list), trả lời streaming có citation bắt buộc. **Bổ sung re-scope**: OIDC JWT verify middleware, Postgres persistence (conversations/messages/audit), endpoints `/trace` (LogsQL passthrough), `/admin/*` (audit/cost/eval/users/health) cho Web BFF gọi.

## Requirements
- p95 latency < 8s (1 turn), < 15s (multi turn)
- Hallucination rate < 2% (mọi kết luận có citation hợp lệ)
- Session cache 10 phút (Redis)
- Semantic query cache hit ≥ 30%
- Rate limit: 30 query/sysadmin/giờ

## Architecture
```
HTTP (JWT bearer) từ Web BFF / Alertmanager handler / (Phase 08) MCP
   │
   ▼
FastAPI app
   ├── middleware: auth STUB (defer) — tạm inject user_id="sysadmin" cho mọi request; interface giữ nguyên để sau plug OIDC/email-pass mà không sửa downstream
   ├── /chat (SSE)         → AgentSession (LangGraph), persist conv+msg Postgres
   ├── /trace              → LogsQL passthrough, redact, paginate
   ├── /admin/audit        → Postgres query
   ├── /admin/cost         → aggregate audit
   ├── /admin/eval/{run}   → trigger eval runner, status
   ├── /admin/users        → CRUD users table
   ├── /admin/health       → ping VL/Qdrant/Redis/Postgres
   ├── /alert              → Alertmanager webhook (Phase 06)
   ├── tools (module dùng chung Phase 08 MCP):
   │     - search_log_templates(query, filters)  → Qdrant
   │     - query_victorialogs(logsql, range)     → VL HTTP /select/logsql/query
   │     - summarize_window(service, range)      → VL aggregate
   │     - list_services_hosts()                 → cached VL stats
   │     - external/{jira,gitlab,metrics,cmdb}_stub  → registry sẵn, body stub trả "not_configured" (Phase 03.5 implement)
   ├── LLM: Claude Sonnet (anthropic SDK, tool-use loop)
   ├── Cache: Redis (session + semantic via Qdrant query cache)
   └── Audit: Postgres `audit_log` (replace JSONL)
```

## Related Code Files
Create:
- `agent/pyproject.toml`
- `agent/src/agent/main.py` (FastAPI app)
- `agent/src/agent/config.py`
- `agent/src/agent/llm_client.py` (Anthropic wrapper, httpx proxy-aware via `HTTPS_PROXY` env)
- `agent/src/agent/graph.py` (LangGraph state + nodes)
- `agent/src/agent/tools/search_log_templates.py`
- `agent/src/agent/tools/query_victorialogs.py`
- `agent/src/agent/tools/summarize_window.py`
- `agent/src/agent/tools/discovery.py` (list_services/hosts)
- `agent/src/agent/tools/registry.py`
- `agent/src/agent/tools/external/__init__.py`
- `agent/src/agent/tools/external/jira_stub.py`
- `agent/src/agent/tools/external/gitlab_stub.py`
- `agent/src/agent/tools/external/metrics_stub.py`
- `agent/src/agent/tools/external/cmdb_stub.py`
- `agent/src/agent/redact.py` (re-use indexer module via shared lib)
- `agent/src/agent/session_cache.py` (Redis)
- `agent/src/agent/semantic_cache.py` (Qdrant cache collection)
- `agent/src/agent/audit.py` (Postgres writer)
- `agent/src/agent/auth/stub.py` (defer auth — return fixed user; thay thế bằng `oidc_verify.py` hoặc `email_pass.py` sau)
- `agent/src/agent/db/client.py` (asyncpg pool)
- `agent/src/agent/db/repositories/conversations.py`
- `agent/src/agent/db/repositories/messages.py`
- `agent/src/agent/db/repositories/audit.py`
- `agent/src/agent/db/repositories/users.py`
- `agent/src/agent/routes/chat.py`
- `agent/src/agent/routes/trace.py`
- `agent/src/agent/routes/admin.py`
- `agent/src/agent/prompts/system.md`
- `agent/tests/test_tools_*.py`
- `agent/tests/test_citation_enforce.py`
- `agent/tests/test_oidc_verify.py`
- `agent/Dockerfile`

## Implementation Steps
1. Scaffold FastAPI + uvicorn, endpoint `POST /chat` SSE, `GET /health`, `GET /metrics`
2. `llm_client.py`: anthropic SDK, model `claude-sonnet-4-5` (hoặc latest), streaming, tool_use parse loop. **Inject `httpx.AsyncClient(proxy=os.getenv("HTTPS_PROXY"))` vào SDK** (`Anthropic(http_client=...)`) — direct hay corp proxy chỉ đổi env, không sửa code. Tương tự cho OpenAI embedding client.
3. `tools/`:
   - `search_log_templates`: input `query`, optional `service/host/severity/time_range`, embed query → Qdrant search top-10 + filter; return chunks với metadata
   - `query_victorialogs`: input LogsQL string + range, HTTP GET VL `/select/logsql/query`, limit 200 lines, redact trước khi return
   - `summarize_window`: query VL aggregate count by template trong window
   - `discovery`: cache 5 phút list distinct service/host từ VL stats
4. `graph.py`: LangGraph StateGraph với nodes: `llm`, `tools`, `validator` (kiểm citation), loop max 5 turn
4b. `tools/external/`: stub adapters cho `jira/gitlab/metrics/cmdb`. Cùng interface internal tool (input schema + async callable). Body return `{"status": "not_configured", "hint": "wire in Phase 03.5"}`. Đăng ký vào `tools/registry.py` với flag `enabled=False` mặc định. **LLM system prompt không expose tool khi disabled** → tránh hallucinate gọi tool stub. Phase 03.5 chỉ cần implement body + flip flag.
5. `prompts/system.md`: enforce — "Mọi kết luận BẮT BUỘC có citation `service:host:timestamp` lấy từ tool result. Nếu không đủ data, gọi thêm tool. Không bịa."
6. `session_cache`: Redis hash, TTL 600s, lưu message history per conversation_id
7. `semantic_cache`: query embed → search collection `query_cache` (Qdrant), cosine ≥ 0.95 → trả cached answer; else write sau khi answer
8. `audit.py`: JSONL append mỗi query: user_id, prompt, tool_calls, answer, tokens, latency, cost_estimate
9. Rate limit middleware: Redis INCR per user_id/hour
10. Dockerfile + compose service `agent`, expose port nội bộ 8080
11. Unit test mỗi tool (mock VL/Qdrant), integration test full flow với canned LLM response
12. Test citation enforcer: bypass attempt → assert reject

## Todo
- [ ] FastAPI scaffold + health/metrics
- [ ] Auth stub middleware (defer, interface ready cho OIDC/email-pass sau)
- [ ] Postgres asyncpg pool + repositories
- [ ] Anthropic client + streaming + tool loop
- [ ] Tool: search_log_templates
- [ ] Tool: query_victorialogs (+ redact)
- [ ] Tool: summarize_window
- [ ] Tool: list_services_hosts (cached)
- [ ] External tool registry stubs (jira/gitlab/metrics/cmdb) — disabled by default, Phase 03.5 wire thật
- [ ] LLM client httpx proxy-aware (`HTTPS_PROXY` env)
- [ ] LangGraph state machine + validator node
- [ ] System prompt + citation rules
- [ ] Session cache Redis
- [ ] Semantic query cache
- [ ] /chat route + conversation persist Postgres
- [ ] /trace route LogsQL passthrough + redact
- [ ] /admin routes (audit/cost/eval/users/health)
- [ ] Audit log Postgres writer
- [ ] Rate limit middleware (per user_id)
- [ ] Dockerfile + compose
- [ ] Unit + integration tests
- [ ] (Sau) Plug auth thật: OIDC hoặc email/pass (Better Auth) — đổi 1 module, không sửa routes

## Success Criteria
- 20 câu hỏi mẫu (Phase 05) đạt p95 < 8s 1-turn
- 100% kết luận có citation hợp lệ (validator pass)
- Semantic cache hit ≥ 30% sau 1 tuần
- Tool error rate < 1%
- Audit log đầy đủ mọi tool call

## Risks
- LLM loop vô hạn → cap max_turns=5, timeout 30s
- Tool VL trả 100k lines → cứng limit 200, paginate prompt
- Anthropic 429 → exponential backoff + Haiku fallback
- Citation bypass → validator node reject + re-prompt 1 lần, sau đó trả "Không đủ data"

## Security
- API key Anthropic/OpenAI từ sops env
- Redact PII trước khi gửi raw log vào prompt
- Audit log chmod 600, log rotate 30d
- Service bind 127.0.0.1, chỉ Telegram bot gọi qua docker network

## Next Steps
- Phase 04 Web app Next.js consume service này qua BFF
- Phase 05 eval harness gọi `/chat` để test, kết quả lưu Postgres
- Phase 08 MCP server share module `tools/` để expose ra Claude Code/Desktop
