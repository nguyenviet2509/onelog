# onelog agent (MVP slice)

FastAPI service exposing `POST /chat` (SSE) — Claude tool-use loop over Qdrant log templates + VictoriaLogs.

## Scope (this slice)
- `/chat` SSE, `/health`
- Self-written tool-use loop (max 5 turns, 30s timeout)
- Citation validator: final answer MUST reference a service+host actually returned by tools, else re-prompt once then refuse
- Auth stub middleware (user_id = "sysadmin")
- `LLM_MOCK` for pre-key dev + deterministic tests
- 2 tools: `search_log_templates` (Qdrant), `query_victorialogs` (LogsQL passthrough + redact)

Deferred to next slice: Postgres persist, Redis session/semantic cache, `/admin/*`, `/trace`, rate limit, external stub tools.

## Run via compose

```bash
cd infra
docker compose --profile agent up -d --build agent
docker compose logs -f agent
```

`LLM_MOCK=true` (default in `.env.example`) makes it work without an Anthropic key — useful for end-to-end pipeline smoke. Set a real `ANTHROPIC_API_KEY` and `LLM_MOCK=false` for real answers.

## Try it

```bash
curl -N -X POST http://localhost:8080/chat \
  -H 'Content-Type: application/json' \
  -d '{"query":"mysql có lỗi gì gần đây?"}'
```

You'll see SSE events: `thinking`, `tool_call`, `tool_result`, `answer`. The `answer` event carries the final text + extracted citations.

## Tests

```bash
cd agent
pip install -e ".[dev]"
pytest -q
```

## Env

| Var | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required unless `LLM_MOCK=true` |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` | |
| `LLM_MOCK` | `false` | Canned playback, no API call |
| `HTTPS_PROXY` | — | Corp proxy for outbound LLM/embedding |
| `OPENAI_API_KEY` | — | Required unless `EMBED_MOCK=true` |
| `EMBED_MOCK` | `false` | Hash-based query vectors |
| `QDRANT_URL` | `http://qdrant:6333` | |
| `QDRANT_COLLECTION` | `log_templates` | Must match indexer |
| `VL_URL` | `http://victorialogs:9428` | |
| `VL_QUERY_LIMIT` | `200` | Server-side cap |
| `AGENT_MAX_TURNS` | `5` | Tool-use loop bound |
| `AGENT_TIMEOUT_S` | `30` | Per-turn timeout |

## File layout

- `src/agent/config.py` — settings
- `src/agent/llm_client.py` — Anthropic + LLM_MOCK
- `src/agent/embed_client.py` — OpenAI query embed + EMBED_MOCK
- `src/agent/tools/` — registry + 2 tools
- `src/agent/agent_loop.py` — tool-use loop + citation validator
- `src/agent/system_prompt.py` — system message
- `src/agent/routes/chat.py` — SSE endpoint
- `src/agent/auth_stub.py` — middleware (defer real auth)
- `src/agent/main.py` — FastAPI app entry
- `src/agent/redact.py` — defense-in-depth at agent boundary
