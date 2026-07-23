# Phase 1 — Scaffold mcp-kb service + Qdrant collection

## Context
- Copy pattern từ `mcp-semantic/` (FastMCP 3.x, Streamable HTTP, structlog, audit, custom_route)
- Không tái tạo auth server — reuse `/auth/verify` của mcp-semantic (Caddy `forward_auth` đã trỏ về đó)
- Qdrant có sẵn, chỉ tạo collection mới

## Priority
High — blocking cho toàn bộ plan.

## Requirements

### Functional
- Service `mcp-kb` chạy trên port `9001` (nội bộ Docker), expose port host `127.0.0.1:9003`
- Endpoint `/mcp` (Streamable HTTP) + `/healthz` (200 OK khi Qdrant reachable)
- Qdrant collection `resolved_incidents` tạo tự động khi service khởi động nếu chưa tồn tại
- Đăng ký `onelog-kb` trong `infra/mcpo/config.template.json`
- Caddy `forward_auth` cho path `/mcp/kb/*` → mcp-semantic:/auth/verify (single token table)

### Non-functional
- Cold start < 5s
- Healthcheck fail nếu Qdrant unreachable → docker restart

## Data model (Qdrant collection)
```
Collection: resolved_incidents
Vector: size = 1536 (text-embedding-3-small), distance = Cosine
Payload schema (validated bằng pydantic):
  error_signature: str (sha256 hex, indexed)
  question:        str
  resolution:      str
  fix_commands:    list[str]
  verify_logsql:   str | None
  resolved_by:     str (email)
  resolved_at:     str (ISO8601)
  verified:        bool (default false, indexed)
  verified_by:     str | None
  verified_at:     str | None
  hit_count:       int (default 0)
  last_hit_at:     str | None
  stale:           bool (default false, indexed)
  stale_reason:    str | None
  tags:            list[str] (indexed)
  chat_ref:        str | None  (OpenWebUI chat id nếu có)
```

Index secondary: `verified`, `stale`, `tags`, `error_signature`.

## Files to create
- `mcp-kb/pyproject.toml` — copy từ `mcp-semantic/pyproject.toml`, đổi name → `onelog-mcp-kb`
- `mcp-kb/Dockerfile` — copy y hệt `mcp-semantic/Dockerfile`
- `mcp-kb/README.md` — mô tả ngắn, curl smoke test
- `mcp-kb/src/mcp_kb/__init__.py`
- `mcp-kb/src/mcp_kb/main.py` — FastMCP init, mount /healthz, register 4 tools (stub cho Phase 2/3)
- `mcp-kb/src/mcp_kb/config.py` — pydantic-settings (QDRANT_URL, QDRANT_API_KEY, QDRANT_COLLECTION=resolved_incidents, LITELLM_BASE_URL, LITELLM_API_KEY, SUMMARIZER_MODEL, EMBED_MODEL, MCP_BEARER_TOKENS, AUDIT_LOG_PATH)
- `mcp-kb/src/mcp_kb/qdrant_store.py` — wrapper: ensure_collection, upsert, search, get, update_payload
- `mcp-kb/src/mcp_kb/embed.py` — copy từ mcp-semantic (OpenAI-compat client)
- `mcp-kb/src/mcp_kb/audit.py` — copy pattern

## Files to modify
- `infra/docker-compose.yml` — thêm service `mcp-kb` (profile: chat, mcp), env vars, healthcheck, port map
- `infra/mcpo/config.template.json` — thêm entry `onelog-kb` → `http://mcp-kb:9001/mcp`
- `infra/caddy/Caddyfile` — thêm route `/mcp/kb/*` với forward_auth
- `infra/.env.example` — thêm SUMMARIZER_MODEL default `deepseek`, MCP_KB_IMAGE_TAG (nếu cần)
- `infra/mcpo` healthcheck script (nếu có) — thêm `onelog-kb` vào list check

## Implementation steps
1. `cp -r mcp-semantic mcp-kb` → rename package `mcp_semantic` → `mcp_kb`, class refs, entrypoint script name
2. Sửa `pyproject.toml` name + entry point
3. Viết `qdrant_store.py`:
   - `ensure_collection()`: kiểm tra tồn tại → tạo với schema trên → tạo payload indexes
   - `upsert(payload, vector)` / `search(vector, filter, limit)` / `get(id)` / `update_payload(id, patch)`
4. Sửa `main.py`:
   - Init FastMCP name `onelog-kb`
   - `@mcp.custom_route("/healthz")` → return 200 nếu Qdrant `.get_collections()` OK
   - Register 4 tools STUBS (return `{"error": "not implemented"}`) — Phase 2/3 fill in
5. Cập nhật docker-compose:
   ```yaml
   mcp-kb:
     build: ../mcp-kb
     container_name: ragstack-mcp-kb
     restart: unless-stopped
     profiles: [chat, mcp]
     environment:
       QDRANT_URL: http://qdrant:6333
       QDRANT_API_KEY: ${QDRANT_API_KEY}
       QDRANT_COLLECTION: resolved_incidents
       OPENAI_API_KEY: ${OPENAI_API_KEY:-}
       OPENAI_BASE_URL: ${OPENAI_BASE_URL:-https://api.openai.com/v1}
       EMBED_MODEL: ${EMBED_MODEL:-text-embedding-3-small}
       LITELLM_BASE_URL: http://litellm-proxy:4000/v1
       LITELLM_API_KEY: ${MCP_KB_LITELLM_KEY}
       SUMMARIZER_MODEL: ${SUMMARIZER_MODEL:-deepseek}
       MCP_BEARER_TOKENS: ${MCP_BEARER_TOKENS:-}
       AUDIT_LOG_PATH: /var/log/onelog-audit/mcp-kb.log
       HOST: 0.0.0.0
       PORT: "9001"
     ports:
       - "127.0.0.1:9003:9001"
     volumes:
       - .\data\audit:/var/log/onelog-audit
     depends_on:
       - qdrant
   ```
6. mcpo config: thêm `onelog-kb` entry
7. Caddyfile: nhân bản block `/mcp/semantic/*` → `/mcp/kb/*`
8. Cập nhật mcpo healthcheck để include `onelog-kb` (nếu smoke check hard-coded)
9. Build + smoke: `docker compose --profile chat up -d --build mcp-kb` → curl `http://127.0.0.1:9003/healthz`
10. Verify collection tự tạo: `curl -H "api-key: $QDRANT_API_KEY" http://127.0.0.1:6333/collections/resolved_incidents`

## Todo
- [ ] Copy mcp-semantic → mcp-kb + rename
- [ ] pyproject.toml + Dockerfile update
- [ ] qdrant_store.py với ensure_collection + CRUD
- [ ] main.py: FastMCP init + /healthz + 4 tool stubs
- [ ] docker-compose entry
- [ ] mcpo config entry
- [ ] Caddyfile route
- [ ] .env.example
- [ ] Build + healthz smoke pass
- [ ] Verify Qdrant collection created

## Success criteria
- `docker compose --profile chat up -d --build mcp-kb` xanh
- `curl http://127.0.0.1:9003/healthz` → 200
- `curl -H "Authorization: Bearer $MCP_TOKEN_OPENWEBUI" http://127.0.0.1:9003/mcp` chấp nhận request (dù tool trả stub)
- Qdrant collection `resolved_incidents` xuất hiện với đúng schema + indexes
- mcpo `/openapi.json` list được 4 tools của onelog-kb

## Risks
- **Qdrant embed dimension mismatch với collection `log_templates` cũ**: mitigate — collection RIÊNG, không share vectors
- **Caddy forward_auth path collision**: mitigate — route mới `/mcp/kb/*` không đè
- **Port 9001 conflict**: verify grep `docker-compose.yml` — nếu conflict đổi 9004

## Security
- Bearer token: reuse `MCP_BEARER_TOKENS` table (single source, revoke một chỗ)
- Audit log riêng cho mcp-kb service

## Next
Phase 2: implement `search_resolutions` + `save_resolution_draft` + summarizer.
