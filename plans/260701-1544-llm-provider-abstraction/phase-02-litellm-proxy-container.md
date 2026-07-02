# Phase 02 — LiteLLM Proxy Container

## Context
- Brainstorm: [../reports/brainstorm-260701-1544-llm-provider-abstraction.md](../reports/brainstorm-260701-1544-llm-provider-abstraction.md)
- Compose: [infra/docker-compose.yml](../../infra/docker-compose.yml)
- Reverse proxy: [infra/Caddyfile](../../infra/Caddyfile)

## Overview
- **Priority:** High
- **Status:** completed (config files, 2026-07-02) — deploy verification chờ có provider keys + logserver
- **Description:** Deploy LiteLLM như proxy container OpenAI-compat để OpenWebUI (Phase 3) và external clients dùng chung endpoint đa provider. Centralize keys, cost tracking, fallback routing.

## Key insights
- LiteLLM proxy = image `ghcr.io/berriai/litellm:main-latest`, config YAML mount vào.
- Expose OpenAI-compat `/chat/completions` endpoint → OpenWebUI/Cursor/bất kỳ client OpenAI-compat nào dùng được.
- Keys chỉ nằm trong container env (không expose ra user).
- Cost tracking qua PostgreSQL (dùng lại `postgres` container hiện có nếu compose có).

## Requirements

### Functional
- Endpoint `http://litellm-proxy:4000/v1/*` OpenAI-compat.
- Model aliases: `gemini-flash`, `gpt-4-mini`, `claude-sonnet`, `deepseek` — user không cần biết provider prefix.
- Fallback: `gemini-flash` fail → `gpt-4-mini` → `claude-sonnet`.
- Cost per request logged tới Postgres (nếu có) hoặc stdout JSON.
- Master key auth (`LITELLM_MASTER_KEY`) cho admin, virtual key per user cho OpenWebUI.

### Non-functional
- Resource: 256Mi RAM, 0.5 CPU.
- Healthcheck `/health` → 200 khi providers reachable.
- Log JSON để dễ tail vào VictoriaLogs.

## Architecture

```
                 Caddy (existing)
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
  /mcp/vl/*   /mcp/semantic/*   /llm/v1/*
   (existing)   (existing)     (new → litellm-proxy:4000)
                                     │
                                     ▼
                              litellm-proxy container
                                     │
              ┌──────────┬──────────┼──────────┐
              ▼          ▼          ▼          ▼
          Anthropic   OpenAI     Gemini     DeepSeek
```

## Related code files

### Create
- `infra/litellm/config.yaml` — model list, aliases, fallback, callback.
- `infra/litellm/.env.template` — env keys template (không commit thật).

### Modify
- `infra/docker-compose.yml` — thêm service `litellm-proxy`.
- `infra/Caddyfile` — thêm route `/llm/*` → `litellm-proxy:4000`.
- `infra/.env.example` — thêm biến LiteLLM.

### Delete
- Không có.

## Implementation steps

### Step 1 — LiteLLM config
```yaml
# infra/litellm/config.yaml
model_list:
  - model_name: gemini-flash
    litellm_params:
      model: gemini/gemini-2.5-flash
      api_key: os.environ/GEMINI_API_KEY

  - model_name: gpt-4-mini
    litellm_params:
      model: openai/gpt-4.1-mini
      api_key: os.environ/OPENAI_API_KEY

  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-5
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: deepseek
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY

router_settings:
  fallbacks:
    - gemini-flash: ["gpt-4-mini", "claude-sonnet"]
    - deepseek: ["gpt-4-mini"]
  num_retries: 2
  timeout: 25  # [RT-F12] < AGENT_TIMEOUT_S=30s tránh race orphan

litellm_settings:
  # [V4] Metrics/cost via stdout JSON → Vector ingest → VictoriaLogs.
  # Không expose Prometheus /metrics endpoint (YAGNI, chưa có Prometheus stack).
  set_verbose: false
  json_logs: true
  drop_params: true  # bỏ silently param provider không support
  # [RT-F10] Malformed response (empty/no-choices) count as fail → next fallback
  # thay vì trả về 200 charge user.
  success_callback: ["validate_response"]
  failure_callback: ["log_incident"]

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  # [RT-F11] Postgres schema isolation — không dùng schema public shared với rag-agent
  database_url: os.environ/DATABASE_URL  # format: postgresql://.../rag?options=-csearch_path%3Dlitellm
```

**[RT-F10] validate_response callback** (place vào `infra/litellm/callbacks/validate.py` mount vào container):
```python
def validate_response(kwargs, completion_response, start_time, end_time):
    choices = getattr(completion_response, "choices", None)
    if not choices or not choices[0].message.content and not choices[0].message.tool_calls:
        raise ValueError("empty response — trigger fallback")
```

### Step 2 — Docker compose service
```yaml
# infra/docker-compose.yml — append
services:
  litellm-proxy:
    image: ghcr.io/berriai/litellm:main-latest
    container_name: onelog-litellm
    restart: unless-stopped
    profiles: ["llm", "all"]
    ports:
      - "127.0.0.1:4000:4000"  # bind localhost, expose qua Caddy
    volumes:
      - ./litellm/config.yaml:/app/config.yaml:ro
      - ./litellm/callbacks:/app/callbacks:ro
    # [RT-F1] Blast radius separation — LiteLLM keys KHÔNG merge với .env
    # global. File .env.llm chỉ container này đọc, chmod 0400 root:root.
    env_file:
      - path: ./litellm/.env.llm
        required: true
    environment:
      LITELLM_MASTER_KEY: ${LITELLM_MASTER_KEY}
      DATABASE_URL: ${LITELLM_DATABASE_URL:-}
    command: ["--config", "/app/config.yaml", "--port", "4000", "--num_workers", "2"]
    healthcheck:
      test: ["CMD", "curl", "-fs", "http://localhost:4000/health/liveliness"]
      interval: 30s
      timeout: 5s
      retries: 3
    networks:
      - onelog
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

### Step 3 — Caddy route
```caddyfile
# infra/Caddyfile — append
handle /llm/* {
    uri strip_prefix /llm
    reverse_proxy litellm-proxy:4000
}
```

Note: LiteLLM đã có auth Bearer built-in — không cần thêm middleware.

### Step 4 — Env template
> **[RT-F1]** Tách 2 file .env — global và LLM-only, khác owner/perm.

```bash
# infra/.env.example — chỉ chứa master key + DB URL, KHÔNG có provider keys
LITELLM_MASTER_KEY=sk-litellm-CHANGE_ME
# [RT-F11] Schema riêng — tạo trước: psql -c "CREATE SCHEMA litellm;"
LITELLM_DATABASE_URL=postgresql://rag:${POSTGRES_PASSWORD}@postgres:5432/rag?options=-csearch_path%3Dlitellm
```

```bash
# infra/litellm/.env.llm.example — mount riêng, chmod 0400 root:root
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
```

Setup command lần đầu:
```bash
sudo install -m 0400 -o root -g root \
  infra/litellm/.env.llm.example infra/litellm/.env.llm
sudo $EDITOR infra/litellm/.env.llm  # paste real keys
```

### Step 5 — Verify smoke
```bash
cd infra
docker compose --profile llm up -d litellm-proxy
docker compose logs -f litellm-proxy

# Test qua Caddy
curl -X POST http://app.local/llm/v1/chat/completions \
  -H "Authorization: Bearer sk-litellm-CHANGE_ME" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-flash","messages":[{"role":"user","content":"hello"}]}'

# Verify fallback: tạm remove GEMINI_API_KEY, redeploy → request gemini-flash phải auto route gpt-4-mini
```

### Step 6 — Virtual keys cho OpenWebUI (Phase 3 dùng)
> **[V6]** Budget cap 500,000 VND/tháng (~$20 USD equivalent) shared team. Alert 80% (400k), reject request khi đạt 100%.

Sau khi container up, tạo virtual key cho OpenWebUI service:
```bash
curl -X POST http://app.local/llm/key/generate \
  -H "Authorization: Bearer sk-litellm-CHANGE_ME" \
  -d '{
    "models":["gemini-flash","gpt-4-mini","claude-sonnet","deepseek"],
    "max_budget":20,
    "budget_duration":"30d",
    "soft_budget":16,
    "key_alias":"openwebui-team"
  }'
```
Lưu key trả về (`sk-...`) → Phase 3 sẽ inject vào OpenWebUI env.

**Budget monitor:** LiteLLM emit event `budget_alert` khi `spend >= soft_budget` → log line JSON → VictoriaLogs (V4). Set alert rule qua VictoriaLogs alerting:
```
budget_alert{key_alias="openwebui-team"} && spend >= 16
```

## Todo list
- [ ] Tạo `infra/litellm/config.yaml`
- [ ] **[RT-F10]** Tạo `infra/litellm/callbacks/validate.py` (empty-response guard)
- [ ] **[RT-F1]** Tạo `infra/litellm/.env.llm` (chmod 0400 root:root), tách khỏi `.env` global
- [ ] **[RT-F11]** Tạo Postgres schema `litellm` trong DB `rag` (không dùng public)
- [ ] Thêm service `litellm-proxy` vào compose
- [ ] Add Caddy route `/llm/*`
- [ ] Update `infra/.env.example`
- [ ] Deploy container, verify `/health/liveliness` green
- [ ] Smoke test qua Caddy với `gemini-flash` model (nếu có key)
- [ ] Verify fallback chain hoạt động (unset primary key, gọi lại)
- [ ] Generate virtual key cho OpenWebUI, lưu vào ops password vault

## Success criteria
- `docker compose ps litellm-proxy` → healthy.
- `curl http://app.local/llm/v1/models -H "Authorization: Bearer $KEY"` → list 4 model aliases.
- `curl /llm/v1/chat/completions` với `gemini-flash` model → response 200 khớp OpenAI schema.
- Log JSON tail được: `docker compose logs litellm-proxy | jq .`.

## Risk assessment

| Rủi ro | Mitigation |
|---|---|
| Master key leak → toàn bộ providers bị lạm dụng | Bind localhost only + Caddy Bearer forwarding; rotate mỗi 90 ngày; audit log tất cả `/key/*` endpoints |
| Cost blow-up khi 1 provider fail loop (retry infinite) | `num_retries: 2` + `timeout: 30` trong config; budget cap qua virtual key `max_budget` |
| LiteLLM version drift break config schema | Pin cụ thể tag thay `main-latest` sau khi verify (vd `v1.55.0-stable`) |
| Postgres cho cost tracking chưa có sẵn | Optional, để `DATABASE_URL` trống ban đầu — cost log ra stdout JSON, mount vào VictoriaLogs |

## Security
- Master key mã hóa trong `.env` (không commit git).
- Provider keys chỉ container `litellm-proxy` đọc — agent service không cần biết keys thật (sẽ point tới proxy ở Phase 3+, agent hiện tại vẫn dùng key trực tiếp cho đơn giản).
- Rate limit per virtual key qua LiteLLM budget config.
- Audit log: tất cả request log có `user`, `model`, `cost`, `latency` — tail vào VictoriaLogs qua rsyslog.

## Next steps
- Phase 3 (OpenWebUI) sẽ point tới `http://litellm-proxy:4000` làm OpenAI-compat backend.
- Optional future: agent service (Phase 1) chuyển sang gọi proxy thay vì gọi provider trực tiếp → thêm 1 layer cost visibility, nhưng thêm 1 hop. Defer decision.
