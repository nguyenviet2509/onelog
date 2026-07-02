# Phase 03 — OpenWebUI Deploy + MCP Wiring

## Context
- Brainstorm: [../reports/brainstorm-260701-1544-llm-provider-abstraction.md](../reports/brainstorm-260701-1544-llm-provider-abstraction.md)
- Depends: Phase 2 (LiteLLM proxy chạy)
- MCP setup hiện tại: [docs/mcp-setup-guide.md](../../docs/mcp-setup-guide.md)

## Overview
- **Priority:** Medium
- **Status:** completed (config, 2026-07-02) — deploy verification + admin bootstrap chờ logserver
- **Description:** Deploy self-hosted OpenWebUI cho team ops, backend point tới LiteLLM proxy, wire 2 MCP servers (`onelog-vl`, `onelog-semantic`) làm tool provider. Thay Claude Desktop.

## Key insights
- OpenWebUI hỗ trợ OpenAI-compat backend + MCP native (từ v0.5+).
- 1 URL cho toàn team → không phải 5 người config 5 lần.
- Chat history persist SQLite (default) hoặc Postgres.
- Auth: OpenWebUI có built-in user table + optional OIDC.

## Requirements

### Functional
- Team truy cập qua `http://app.local/webui` (behind Caddy).
- **[V1]** Login qua **local user table** OpenWebUI (không SSO/OIDC). 5 ops invite-only. Bootstrap admin qua ENV lần đầu (RT-F2).
- Model picker: `gemini-flash` (default), `gpt-4-mini`, `claude-sonnet`, `deepseek`.
- MCP tools từ `onelog-vl` + `onelog-semantic` khả dụng trong chat.
- Chat history per user, share được với teammate qua link.

### Non-functional
- Resource: 512Mi RAM, 1 CPU.
- HTTPS-ready (khi Caddy có TLS).
- Backup chat history hằng ngày.

## Architecture

```
   ops user
      │ HTTPS
      ▼
    Caddy
      │ /chat/* → openwebui:8080
      ▼
  OpenWebUI (container)
      │
      ├─ OpenAI backend → litellm-proxy:4000 (Phase 2)
      │      │
      │      └─→ Gemini/GPT/Claude/DeepSeek
      │
      └─ MCP clients
             ├─→ mcp-vl:8000    (existing)
             └─→ mcp-semantic:8000 (existing)
```

## Related code files

### Create
- `infra/openwebui/mcp-config.json` — MCP server list mount vào container.
- `docs/openwebui-user-guide.md` — hướng dẫn login/chat/share cho ops team (Vietnamese).

### Modify
- `infra/docker-compose.yml` — thêm service `openwebui`.
- `infra/Caddyfile` — thêm route `/chat/*` → `openwebui:8080`.
- `infra/.env.example` — thêm biến OpenWebUI.
- `docs/mcp-setup-guide.md` — chuyển section chính sang OpenWebUI, giữ Claude Desktop làm appendix (Phase 5).

### Delete
- Không có (chưa xóa Claude Desktop path, để migration graceful).

## Implementation steps

### Step 1 — Docker compose service
```yaml
# infra/docker-compose.yml — append
services:
  openwebui:
    image: ghcr.io/open-webui/open-webui:main
    container_name: onelog-openwebui
    restart: unless-stopped
    profiles: ["chat", "all"]
    ports:
      - "127.0.0.1:8090:8080"
    volumes:
      - openwebui-data:/app/backend/data
      - ./openwebui/mcp-config.json:/app/backend/data/mcp-config.json:ro
    environment:
      # Backend LLM = LiteLLM proxy (Phase 2)
      OPENAI_API_BASE_URL: http://litellm-proxy:4000/v1
      OPENAI_API_KEY: ${OPENWEBUI_LITELLM_VIRTUAL_KEY}

      # Disable Ollama (không dùng)
      ENABLE_OLLAMA_API: "false"

      # UI
      WEBUI_NAME: "OneLog Chat"
      DEFAULT_MODELS: "gemini-flash"
      DEFAULT_USER_ROLE: "user"  # signup mặc định là user, admin phải promote
      # [RT-F2] KHÔNG mở signup lần đầu — race condition ai đăng ký trước = admin.
      # Bootstrap admin qua ENV, signup=false ngay từ boot, mở lại sau khi admin có.
      ENABLE_SIGNUP: "false"
      WEBUI_AUTH_TRUSTED_EMAIL_HEADER: ""
      # Bootstrap admin lần đầu (chỉ dùng khi DB rỗng):
      # Sau khi container up + admin verified, unset 2 biến này.
      # ADMIN_EMAIL: ${OPENWEBUI_BOOTSTRAP_ADMIN_EMAIL}
      # ADMIN_PASSWORD: ${OPENWEBUI_BOOTSTRAP_ADMIN_PASSWORD}

      # Auth
      WEBUI_SECRET_KEY: ${OPENWEBUI_SECRET_KEY}

      # MCP (native support)
      ENABLE_MCP: "true"
      MCP_CONFIG_PATH: /app/backend/data/mcp-config.json
    networks:
      - onelog
    # [RT-F13] service_started không phải service_healthy — tránh boot deadlock
    # khi LiteLLM healthcheck fail tạm thời do 1 provider down.
    # OpenWebUI retry connect ở first request thay vì wait vô hạn.
    depends_on:
      litellm-proxy:
        condition: service_started

volumes:
  openwebui-data:
```

### Step 2 — MCP config cho OpenWebUI
> **[RT-F3]** Token riêng cho OpenWebUI (`MCP_TOKEN_OPENWEBUI`), không share với `MCP_BEARER_INTERNAL`
> của agent hay Claude Desktop. Revoke độc lập khi client compromise.

```json
{
  "mcpServers": {
    "onelog-vl": {
      "url": "http://mcp-vl:8000/sse",
      "transport": "sse",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN_OPENWEBUI}"
      }
    },
    "onelog-semantic": {
      "url": "http://mcp-semantic:8000/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN_OPENWEBUI}"
      }
    }
  }
}
```

**Ops setup:** thêm `MCP_TOKEN_OPENWEBUI` vào bearer allowlist của `mcp-semantic` + `mcp-vl` — riêng biệt với tokens của agent/Claude Desktop. Xem `infra/scripts/gen-mcp-tokens.sh` để generate.

Note: `mcp-vl` và `mcp-semantic` cùng docker network → gọi qua tên service, không cần đi qua Caddy.

### Step 2b — [RT-F6] Fallback: OpenWebUI Functions nếu MCP native fail
Nếu debug MCP native config > 2h vẫn không connect (schema mismatch, transport bug), chuyển sang OpenWebUI **Functions** API:

```python
# openwebui-functions/onelog_tools.py — upload qua Admin UI
import httpx

class Tools:
    def search_log_templates(self, query: str, limit: int = 5) -> str:
        """Search log templates trong Qdrant qua mcp-semantic."""
        r = httpx.post("http://mcp-semantic:8000/tool/search_log_templates",
                       json={"query": query, "limit": limit},
                       headers={"Authorization": f"Bearer {MCP_TOKEN_OPENWEBUI}"})
        return r.json()
```

Trade-off: mất autonomy of MCP protocol, nhưng model call tool được. Chấp nhận cho MVP nếu MCP native chưa stable.

### Step 3 — Caddy route
```caddyfile
# infra/Caddyfile — append
handle_path /chat* {
    reverse_proxy openwebui:8080
}
```

**Lưu ý conflict:** `/chat` cũng là endpoint của `agent` service `/chat` SSE. Chọn 1 trong 2:
- OpenWebUI dùng `/webui/*`
- Hoặc agent service move sang `/api/chat`

Đề xuất: OpenWebUI ở `/webui/*` để không break existing agent API.

### Step 4 — Env
```bash
# infra/.env.example — append
OPENWEBUI_SECRET_KEY=CHANGE_ME_32_CHARS
OPENWEBUI_LITELLM_VIRTUAL_KEY=  # từ Phase 2 Step 6
MCP_BEARER_INTERNAL=  # existing token dùng internal network
```

### Step 5 — Initial admin setup
```bash
docker compose --profile chat up -d openwebui
# Mở http://app.local/webui, tạo account đầu tiên (auto-admin)
# Admin panel → Settings → Models → verify 4 models từ LiteLLM hiện diện
# Admin panel → MCP → verify 2 servers connect (tool list load được)
# Tắt ENABLE_SIGNUP sau khi 5 ops đăng ký xong
```

### Step 6 — Smoke test
1. Login user thường, chọn model `gemini-flash`.
2. Chat: "Dùng search_log_templates tìm log về database disconnect".
3. Verify tool được gọi, kết quả có citation với vmui_url.
4. Đổi model sang `claude-sonnet`, cùng query, verify parity.

### Step 7 — Backup script (encrypted-at-rest)
> **[RT-F4]** Backup .tgz chứa chat history có thể có PII paste từ log raw — encrypt trước khi lưu.
> **[V5]** Retention: **giữ vĩnh viễn** (không auto-purge). Chỉ xóa backup > 90 ngày trên logserver, offsite giữ vĩnh viễn.

```bash
# infra/scripts/backup-openwebui.sh
#!/bin/bash
set -euo pipefail
STAMP=$(date +%Y%m%d)
KEY=/etc/onelog/backup-age.pub  # age public key, generate 1 lần: age-keygen -o backup-age.key
docker compose exec -T openwebui tar -cz -C /app/backend/data . \
  | age -R "$KEY" > /var/backups/openwebui-${STAMP}.tgz.age
find /var/backups -name "openwebui-*.tgz.age" -mtime +30 -delete
```

Cron `0 3 * * *`. Private key `backup-age.key` lưu ops vault (không trên logserver). Restore: `age -d -i backup-age.key openwebui-YYYYMMDD.tgz.age | tar -xz`.

## Todo list
- [ ] Tạo `infra/openwebui/mcp-config.json`
- [ ] Thêm service `openwebui` + volume vào compose
- [ ] Add Caddy route `/webui/*`
- [ ] Update `.env.example` với 3 biến mới
- [ ] Deploy container, kiểm tra `depends_on: service_started` (không phải healthy — RT-F13)
- [ ] **[RT-F2]** Bootstrap admin qua ENV (`ADMIN_EMAIL/PASSWORD`), verify signup đã lock, unset ENV
- [ ] **[RT-F3]** Generate `MCP_TOKEN_OPENWEBUI` riêng, thêm vào bearer allowlist mcp-vl + mcp-semantic
- [ ] **[RT-F6]** Nếu MCP native fail > 2h → chuyển plan sang OpenWebUI Functions (Step 2b)
- [ ] **[RT-F4]** Generate age keypair cho backup encryption, private key vào vault
- [ ] Đăng ký tài khoản admin đầu tiên
- [ ] Verify 4 model aliases từ LiteLLM xuất hiện
- [ ] Verify 2 MCP servers connect, tool list load
- [ ] Smoke test: chat với `gemini-flash` gọi `search_log_templates`
- [ ] Tạo 5 tài khoản ops team, tắt `ENABLE_SIGNUP`
- [ ] Deploy backup script + cron
- [ ] Ghi lại admin credentials vào ops vault

## Success criteria
- 5 ops user login được, thấy 4 model + MCP tools.
- Query VI + tool call qua OpenWebUI produce citation `[service:host:...]` hợp lệ.
- Chat history persist qua restart container.
- Backup file `.tgz` xuất hiện sau khi cron chạy lần đầu.

## Risk assessment

| Rủi ro | Mitigation |
|---|---|
| OpenWebUI MCP support chưa stable (feature mới v0.5+) | Pin version cụ thể sau smoke test; fallback: mount tools qua LiteLLM function definitions thay MCP native |
| SQLite corrupt khi restart bất thường | Backup script + option upgrade Postgres backend nếu >5 người dùng |
| Signup mở đầu → risk external user tự đăng ký nếu Caddy chưa auth | Bind localhost only, add Caddy `basicauth` cho `/webui/*` trước khi có TLS/OIDC |
| Path conflict `/chat` với agent API | Chọn prefix `/webui/*` như đề xuất Step 3 |
| MCP bearer token internal leak nếu container ENV log ra | Không log ENV, dùng docker secrets ở phase deploy sau |

## Security
- Bind `127.0.0.1:8090` — chỉ Caddy access.
- Caddy layer sẽ thêm TLS + optional basicauth trước public.
- `WEBUI_SECRET_KEY` random 32 chars, generate 1 lần và lưu vault.
- Session cookie httpOnly + secure (OpenWebUI default).
- Sau setup: tắt `ENABLE_SIGNUP`, chỉ admin invite user.

## Next steps
- Phase 4 dùng OpenWebUI để chạy 20-query benchmark manually (hoặc via API).
- Phase 5 update docs cho team migration.
- Future: OIDC integration nếu công ty có SSO (Keycloak/Authentik).
