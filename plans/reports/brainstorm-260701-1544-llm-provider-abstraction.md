# Brainstorm — LLM Provider Abstraction cho OneLog

- Date: 2026-07-01
- Owner: anhtct@inet.vn
- Status: design approved (pending plan)

## 1. Problem statement

OneLog hiện couple với Claude ở 2 chỗ:
1. **Agent service** (`agent/src/agent/llm_client.py`) — hard-code Anthropic SDK, dùng content-block schema (`tool_use`/`tool_result`/`stop_reason`) rò rỉ vào `agent_loop.py`.
2. **End-user path** — team dùng Claude Desktop làm MCP host (docs/mcp-setup-guide.md).

Mục tiêu: thay Claude bằng GPT / Gemini / DeepSeek. **Driver chính: cost reduction** (Gemini Flash, DeepSeek-V3 rẻ hơn Claude Sonnet 3-10x).

Non-goal (giai đoạn này): on-prem/local model, runtime A/B switching per-request.

## 2. Key insight

**MCP servers đã LLM-agnostic sẵn** (chỉ nói MCP protocol). Chỉ 2 việc cần làm:
- Agent service: thêm abstraction layer.
- End-user: đổi host client (không phải server).

Không phải rebuild — chỉ swap boundary.

## 3. Approaches evaluated

### 3.1 Agent service abstraction

| # | Approach | Effort | Pros | Cons | Verdict |
|---|---|---|---|---|---|
| 1A | **LiteLLM** | 1 ngày, ~70 LOC | 1 dep phủ 4 provider, retries/cost tracking free, cộng đồng lớn | Dep bên 3, đôi khi provider quirks rò rỉ | ✅ **CHỌN** |
| 1B | Hand-rolled adapter | 2-3 ngày, ~400 LOC | Full control, no extra dep | Tự bảo trì schema drift (tool-use spec đổi ~2x/năm) | Reject: over-engineer |
| 1C | MCP-ify agent | 1 tuần | Single tool source of truth | Refactor lớn, thêm latency | Reject: YAGNI |

### 3.2 End-user MCP client

| # | Approach | Effort | Pros | Cons | Verdict |
|---|---|---|---|---|---|
| 2A | Update docs (Cursor + Claude Desktop parallel) | doc-only | Zero code | UX phân mảnh 5 người 5 host | Reject |
| 2B | **Self-hosted OpenWebUI/LibreChat + LiteLLM proxy** | 1-2 ngày | 1 URL team, đa provider centralized, cost tracking, share chat | Ops thêm 1 container | ✅ **CHỌN** |
| 2C | Defer client-side | — | Focus backend | Không giải quyết Claude Desktop lock-in | Reject |

## 4. Recommended solution

**Architecture:**

```
┌────────────────────────────────────────────────────────────────┐
│                       End users (5 ops)                        │
└───────────────────────────┬────────────────────────────────────┘
                            │ HTTPS
                    ┌───────▼────────┐
                    │  OpenWebUI     │  (self-host, Docker)
                    │  (chat UI)     │
                    └───────┬────────┘
                            │ OpenAI-compat API
                    ┌───────▼────────┐
                    │  LiteLLM proxy │  (router, cost-track, keys)
                    └───┬────┬───┬───┘
                        │    │   │
              ┌─────────┘    │   └────────┐
              ▼              ▼            ▼
        Anthropic          OpenAI      Gemini / DeepSeek
                            │
                            │ (MCP tool calls)
                            ▼
              ┌─────────────────────────┐
              │ mcp-vl + mcp-semantic   │  (unchanged, MCP protocol)
              └─────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│                    Agent service /chat SSE                     │
└───────────────────────────┬────────────────────────────────────┘
                            │
                    ┌───────▼────────┐
                    │ agent_loop.py  │
                    └───────┬────────┘
                            │ (normalized: OpenAI-style)
                    ┌───────▼────────┐
                    │ llm_client.py  │ ← rewrite: litellm.acompletion
                    └───────┬────────┘
                            │
                (same fan-out to 4 providers)
```

**Provider defaults (cost-optimized):**

| Env | Value | Reason |
|---|---|---|
| `LLM_PROVIDER` | `gemini` | Default cho cost |
| `LLM_MODEL` | `gemini/gemini-2.5-flash` | Cheap + fast, VI tốt |
| Fallback | `openai/gpt-4.1-mini` | LiteLLM fallback nếu Gemini fail |
| Premium | `anthropic/claude-sonnet-4-5` | Cho query khó, opt-in per-request header |

## 5. Change surface

### Agent service
| File | Change |
|---|---|
| `agent/pyproject.toml` | + `litellm>=1.50` |
| `agent/src/agent/config.py` | + `llm_provider`, `llm_model`, `llm_max_tokens`; keep `anthropic_api_key`, add `openai_api_key`, `gemini_api_key`, `deepseek_api_key` |
| `agent/src/agent/llm_client.py` | Rewrite `create()` gọi `litellm.acompletion`; giữ mock branch |
| `agent/src/agent/agent_loop.py` | Adapt normalized response (OpenAI-shape `tool_calls`) → giữ nguyên citation validator |
| `agent/tests/` | Param tests với 2 mock providers |
| `.env.example` | + `LLM_PROVIDER`, `LLM_MODEL`, provider keys |

### Ops layer (new)
| File | Change |
|---|---|
| `infra/docker-compose.yml` | + `litellm-proxy` service, + `openwebui` service (behind Caddy) |
| `infra/litellm/config.yaml` | Provider routing, model aliases, cost caps |
| `infra/openwebui/` | Config connect LiteLLM as OpenAI-compat backend + MCP servers |
| `infra/Caddyfile` | Routes `/chat` (OpenWebUI), `/llm` (LiteLLM admin, IP-whitelist) |

### Docs
| File | Change |
|---|---|
| `docs/mcp-setup-guide.md` | Chuyển section chính sang OpenWebUI, giữ Claude Desktop appendix |
| `docs/deployment-guide.md` | + LiteLLM + OpenWebUI ops steps |
| `docs/onelog-team-project-guide.md` | Update workflow (chat qua OpenWebUI thay Claude Desktop) |

## 6. Risks & mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Tool-use fidelity Gemini/DeepSeek yếu hơn Claude (malformed args) | Tool calls fail → user không nhận được answer | Citation validator (agent_loop.py:110) đã strict — giữ nguyên. LiteLLM fallback chain: Gemini → GPT-4.1-mini → Claude |
| Vietnamese quality DeepSeek yếu | UX kém khi user hỏi VI | Benchmark 20 real queries trước prod switch; default = Gemini Flash (VI tốt) |
| Prompt caching semantics khác nhau (Anthropic có cache, DeepSeek không) | Cost cao hơn expected với provider không cache | Track qua LiteLLM `success_callback`; nếu cost vượt threshold, alert |
| Streaming chunk shape khác nhau (nếu sau này stream LLM output) | Refactor lại SSE | LiteLLM handles unified streaming — an toàn nếu chọn 1A |
| OpenWebUI operational overhead (auth, backup chat history) | Ops burden | Deploy tối thiểu: SQLite storage, OIDC via existing SSO nếu có; docs backup script |
| Key sprawl (4 providers × 5 users nếu leak) | Cost blast radius | Chỉ LiteLLM giữ keys; user auth qua OpenWebUI, không thấy raw keys |

## 7. Success metrics

- Agent `/chat` tests pass với ≥ 2 providers (Anthropic + Gemini) — same test suite, 1 env var difference.
- Cost/1000 queries: Gemini Flash < 40% Claude Sonnet baseline (target).
- Tool-call success rate ≥ 95% cho top-3 provider (Anthropic/Gemini/GPT) trên 20-query VI benchmark set.
- Ops team migrate 100% từ Claude Desktop sang OpenWebUI trong 2 tuần sau rollout.

## 8. Implementation phases (đề xuất — chi tiết do /ck:plan sinh)

1. **Phase 1** — Agent service LLM abstraction (LiteLLM). Test parity với Anthropic baseline.
2. **Phase 2** — LiteLLM proxy container + config. Standalone deploy, test 4 providers.
3. **Phase 3** — OpenWebUI deploy, wire MCP servers, team migration guide.
4. **Phase 4** — Benchmark 20-query VI test set × 4 providers, publish cost/quality matrix.
5. **Phase 5** — Docs sync (mcp-setup, deployment, team-project).

## 9. Unresolved questions

1. Có SSO/OIDC sẵn cho OpenWebUI auth không, hay dùng local user table?
2. Chat history của OpenWebUI có cần retention policy (GDPR / compliance nội bộ)?
3. LiteLLM proxy có expose Prometheus metrics vào stack `victorialogs` hiện tại không?
4. Ai giữ provider API keys production (ops admin only, hay Vault)?
5. Có budget alert threshold cụ thể (VND/tháng) để LiteLLM cost guard trigger?
