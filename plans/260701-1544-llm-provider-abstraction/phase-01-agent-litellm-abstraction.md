# Phase 01 — Agent service LiteLLM abstraction

## Context
- Brainstorm: [../reports/brainstorm-260701-1544-llm-provider-abstraction.md](../reports/brainstorm-260701-1544-llm-provider-abstraction.md)
- Files hiện tại: [agent/src/agent/llm_client.py](../../agent/src/agent/llm_client.py), [agent/src/agent/agent_loop.py](../../agent/src/agent/agent_loop.py), [agent/src/agent/config.py](../../agent/src/agent/config.py)

## Overview
- **Priority:** High (blocker cho các phase sau)
- **Status:** completed (mock-based, 2026-07-02) — Spike PoC deferred đến khi có provider keys
- **Description:** Thay `AsyncAnthropic` bằng `litellm.acompletion`. Chuẩn hóa response shape từ Anthropic content-blocks sang OpenAI-style `tool_calls`. Giữ nguyên `agent_loop.py` public behavior (SSE events, citation validator).

## Key insights
- LiteLLM đã normalize tool-use theo schema OpenAI — chỉ dịch 1 lần tại `llm_client.py`.
- Citation validator (`agent_loop.py:110`) là safety net cho provider yếu (Gemini/DeepSeek tool-use flaky) — **không được relax**.
- Mock branch giữ nguyên, chỉ cần output shape khớp với normalized response.

## Requirements

### Functional
- 1 env var `LLM_MODEL` swap được provider (format: `provider/model`, ví dụ `gemini/gemini-2.5-flash`, `anthropic/claude-sonnet-4-5`, `openai/gpt-4.1-mini`, `deepseek/deepseek-chat`).
- Fallback chain: nếu primary provider fail (5xx / timeout), auto retry provider #2, #3 (config qua LiteLLM).
- Tool-use loop hoạt động parity giữa Anthropic vs Gemini với cùng test suite.
- Citation validator hoạt động không đổi.

### Non-functional
- Latency overhead LiteLLM < 50ms/turn.
- Không break `LLM_MOCK=true` mode.
- Backward compat: giữ `ANTHROPIC_API_KEY` env var, deprecate warning nếu thiếu `LLM_MODEL`.

## Architecture

```
agent_loop.py
    │  gọi llm.create(system, messages, tools)
    ▼
llm_client.py
    │  self._mock → mock branch (giữ nguyên)
    │  else → litellm.acompletion(model=settings.llm_model, messages=..., tools=...)
    ▼
LiteLLM SDK
    │  route theo prefix (anthropic/, openai/, gemini/, deepseek/)
    ▼
Provider API
    │  response
    ▼
_normalize_to_anthropic_shape()  # dịch OpenAI tool_calls → Anthropic content blocks
    ▼
{content: [...], stop_reason: str}  # unchanged interface với agent_loop.py
```

**Chiến lược adapter:** LiteLLM trả OpenAI-shape (choices[0].message.tool_calls). Adapter chuyển về Anthropic-shape (`content: [{type:'text'}, {type:'tool_use'}]`) để `agent_loop.py` không đổi.

## Related code files

### Modify
- `agent/pyproject.toml` — thêm `litellm>=1.50.0`
- `agent/src/agent/config.py` — thêm settings, deprecate riêng
- `agent/src/agent/llm_client.py` — rewrite `create()`
- `agent/tests/test_llm_client.py` — param test với 2 providers (mock)
- `agent/tests/test_agent_loop.py` — verify shape parity
- `.env.example` — thêm biến mới

### Create
- Không có file mới. Giữ KISS.

### Delete
- Không có.

## Implementation steps

### Step 0 — Spike PoC (2h, MANDATORY trước code adapter)
> **[RT-F5]** Verify assumption: LiteLLM normalize tool-use parity giữa Anthropic/Gemini/DeepSeek — CHƯA có evidence trong plan gốc.

```python
# scripts/spike-litellm-toolcall.py — throw-away
import asyncio, litellm, os

TOOL = [{"type":"function","function":{
    "name":"search_log_templates",
    "description":"search log templates",
    "parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}
}}]

async def probe(model):
    r = await litellm.acompletion(
        model=model,
        messages=[{"role":"user","content":"tìm log mysql error"}],
        tools=TOOL, tool_choice="auto", max_tokens=512,
    )
    msg = r.choices[0].message
    print(f"\n=== {model} ===")
    print("finish_reason:", r.choices[0].finish_reason)
    print("tool_calls:", msg.tool_calls)
    print("content:", msg.content)

for m in ["anthropic/claude-sonnet-4-5","gemini/gemini-2.5-flash","deepseek/deepseek-chat"]:
    asyncio.run(probe(m))
```

**Gate criteria:** Cả 3 provider phải:
1. Return `finish_reason` deterministic (`tool_calls` / `stop` / equivalent) — không None.
2. `tool_calls[0].function.arguments` parse được thành JSON hợp lệ.
3. `tool_calls[0].function.name == "search_log_templates"`.

**Nếu gate fail:** Không proceed Step 1 — mở finding trong plan, expand scope adapter (có thể phải handle Gemini `functionCall` camelCase quirk, DeepSeek arguments-as-string). Ước tính effort có thể +0.5 ngày.

### Step 1 — Update dependencies
```toml
# agent/pyproject.toml
dependencies = [
    ...
    "litellm>=1.50.0",
    # anthropic vẫn giữ (LiteLLM optional dep cho Anthropic)
]
```

### Step 2 — Config settings
```python
# agent/src/agent/config.py
class Settings(BaseSettings):
    llm_model: str = "anthropic/claude-sonnet-4-5"  # default parity với hiện tại
    llm_max_tokens: int = 4096
    llm_fallback_models: list[str] = []  # e.g. ["openai/gpt-4.1-mini", "gemini/gemini-2.5-flash"]
    llm_enable_prompt_cache: bool = True  # [V7] Default ON cho anthropic/*

    # Deprecated nhưng giữ để BC
    anthropic_api_key: str | None = None
    anthropic_model: str | None = None  # nếu set, override llm_model (BC path)
    anthropic_max_tokens: int | None = None

    # Provider keys — LiteLLM tự đọc env, không cần map field
    openai_api_key: str | None = None
    gemini_api_key: str | None = None
    deepseek_api_key: str | None = None

    llm_mock: bool = False
```

**BC logic:** nếu `anthropic_model` set và `llm_model` không set → dùng `anthropic/{anthropic_model}`.

### Step 3 — Rewrite `llm_client.py`
```python
import litellm

class LLMClient:
    def __init__(self):
        self._mock = settings.llm_mock or _no_provider_key()
        # LiteLLM tự pick key từ env, không cần setup client
        self._model = _resolve_model(settings)
        self._fallbacks = settings.llm_fallback_models

    async def create(self, *, system, messages, tools):
        if self._mock:
            return _mock_response(messages)

        # Chuyển messages Anthropic-shape → OpenAI-shape
        oai_messages = _anthropic_to_openai_messages(system, messages)
        oai_tools = _anthropic_to_openai_tools(tools)

        # [RT-F12] LiteLLM timeout 25s < AGENT_TIMEOUT_S=30s để tránh race
        # orphan request khi agent timeout trước response về (charge kép provider).
        # [V7] Claude prompt caching default ON cho anthropic/* — giảm cost ~65%.
        # LiteLLM tự inject cache_control vào system prompt + tool schema khi model
        # prefix là anthropic/. Provider khác ignore param.
        extra_params = {}
        if self._model.startswith("anthropic/") and settings.llm_enable_prompt_cache:
            extra_params["extra_headers"] = {"anthropic-beta": "prompt-caching-2024-07-31"}

        resp = await litellm.acompletion(
            model=self._model,
            messages=oai_messages,
            tools=oai_tools,
            max_tokens=settings.llm_max_tokens,
            fallbacks=self._fallbacks or None,
            timeout=25,
            **extra_params,
        )

        return _openai_to_anthropic_response(resp)
```

**Helper functions** (giữ trong cùng file, <100 LOC):
- `_anthropic_to_openai_messages(system, messages)` — merge system vào messages[0], convert `content: [{type:'tool_result'}]` → `role='tool', tool_call_id=..., content=str`, convert `content: [{type:'tool_use'}]` → `role='assistant', tool_calls=[...]`.
- `_anthropic_to_openai_tools(tools)` — Anthropic dùng `input_schema`, OpenAI dùng `{type:'function', function:{name, description, parameters}}`.
- `_openai_to_anthropic_response(resp)` — `choices[0].message.tool_calls` → `content: [{type:'tool_use', id, name, input}]`; `finish_reason='tool_calls'` → `stop_reason='tool_use'`, else `'end_turn'`.

### Step 4 — Tests

**Unit tests (`test_llm_client.py`):**
- Mock `litellm.acompletion`, verify request shape đúng format OpenAI.
- Verify response transform: OpenAI tool_calls → Anthropic content blocks.
- Verify BC: `ANTHROPIC_MODEL=claude-sonnet-4-5` không set `LLM_MODEL` → resolve `anthropic/claude-sonnet-4-5`.
- Mock branch unchanged.

**Integration tests (`test_agent_loop.py`):**
- Param `[anthropic, gemini]`, mock LiteLLM responses per provider, verify citation validator pass.
- Verify tool-use loop terminate đúng ở max_turns.

### Step 5 — .env.example
```bash
# LLM (mới)
LLM_MODEL=anthropic/claude-sonnet-4-5
LLM_MAX_TOKENS=4096
LLM_FALLBACK_MODELS=  # csv, vd: openai/gpt-4.1-mini,gemini/gemini-2.5-flash

# Provider keys (chỉ set cho provider bạn dùng)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
DEEPSEEK_API_KEY=

LLM_MOCK=false
```

## Todo list
- [ ] **[RT-F5]** Step 0 Spike PoC 3 provider — gate criteria pass
- [ ] Add `litellm>=1.50.0` vào pyproject.toml
- [ ] Update `config.py` với settings mới + BC logic
- [ ] Rewrite `llm_client.py` với LiteLLM + shape adapter
- [ ] Viết 4 helper functions convert Anthropic ↔ OpenAI shape
- [ ] Update unit tests (param 2 providers)
- [ ] Update integration test cho agent_loop parity
- [ ] Chạy full test suite với `LLM_MODEL=anthropic/...` — pass
- [ ] Chạy full test suite với `LLM_MODEL=gemini/gemini-2.5-flash` (mock) — pass
- [ ] Manual smoke: `curl POST /chat` với real Gemini key
- [ ] Update `.env.example` + `agent/README.md` env table

## Success criteria
- `pytest agent/tests -q` pass 100% với cả 2 provider config.
- `curl -N POST /chat` với `LLM_MODEL=gemini/gemini-2.5-flash` trả về SSE event `answer` với citation hợp lệ trên 3 query VI thực tế.
- Zero regression: chạy `LLM_MODEL=anthropic/claude-sonnet-4-5` behavior giống trước refactor.
- BC verify: chỉ set `ANTHROPIC_MODEL` (không set `LLM_MODEL`) → agent vẫn chạy như cũ.

## Risk assessment

| Rủi ro | Mitigation |
|---|---|
| Shape adapter miss edge case (tool result là list, không phải string) | Snapshot test với 5 recorded tool_result payloads thực tế từ mcp-semantic |
| LiteLLM async client không compat với httpx proxy đang dùng | LiteLLM hỗ trợ `HTTPS_PROXY` env — verify manual, không phải set qua code |
| Gemini `tool_calls` schema có `functionCall` (camelCase) khác OpenAI | LiteLLM đã normalize — verify bằng integration test thực tế |
| DeepSeek đôi khi trả `arguments` là string JSON không parse được | Adapter try/except, fallback error tool_result trong loop hiện tại đã handle |

## Security
- Provider keys chỉ đọc từ env — không log ra structlog output.
- LiteLLM verbose mode OFF trong production (`litellm.set_verbose = False`).
- Rate limit / cost cap sẽ thêm ở Phase 2 (LiteLLM proxy).

## Next steps
- Phase 2 (proxy) chạy song song được — không depend nhau về code.
- Phase 4 benchmark cần Phase 1 complete để test đa provider.
