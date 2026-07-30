# Phase 2 — Deploy bookstack-mcp container

**Status:** pending
**Priority:** P0
**Effort:** ~1h
**Depends on:** Phase 1 (need token)

## Mục tiêu

Chạy `ghcr.io/ttpears/bookstack-mcp:latest` như 1 service trong `docker-compose.yml` của OneLog, chế độ Streamable HTTP, read-only.

## Files to modify

- `d:\Vietnt\Project\onelog\infra\docker-compose.yml` — add service `bookstack-mcp` (DONE ở cook)
- `d:\Vietnt\Project\onelog\infra\mcpo\config.template.json` — add upstream `bookstack` (DONE ở cook)
- `d:\Vietnt\Project\onelog\infra\.env.example` — thêm `KB_INET_*` (DONE ở cook)
- `/opt/onelog/infra/.env` (on VPS) — set giá trị thật (không commit)

## Implementation

### 2.1 Compose service (đã config)

Service definition đã add vào `infra/docker-compose.yml` (grep `bookstack-mcp`). Chạy dưới profile `chat` (giống openwebui + mcpo).

### 2.2 Env template

Append `.env.example`:
```
# BookStack (KB.inet) API — cho bookstack-mcp bridge
KB_INET_TOKEN_ID=
KB_INET_TOKEN_SECRET=
```

### 2.3 Deploy

Follow `.claude/rules/host-sync-policy.md`:
1. Commit thay đổi ở local (compose + mcpo config + env.example).
2. Push `origin/master`.
3. SSH `onelog-vps` → `cd /opt/onelog` → `git pull` → set `KB_INET_TOKEN_*` trong `infra/.env`.
4. `cd infra && docker compose --profile chat up -d bookstack-mcp` → verify healthy.
5. `docker compose --profile chat up -d --force-recreate mcpo` (mcpo re-discover tools).
6. `docker compose logs -f bookstack-mcp mcpo` → không error.
7. Test từ VPS:
   ```bash
   # Via mcpo → OpenAPI
   curl -sS -H "Authorization: Bearer $MCPO_API_KEY" \
     http://127.0.0.1:8091/bookstack/openapi.json | jq '.paths | keys | length'
   # → phải >= 15 (số tool read-only)
   ```

## Success criteria

- [ ] `docker compose ps` → bookstack-mcp `healthy`.
- [ ] `tools/list` trả về danh sách tool có `search_pages`, `get_page`, `get_recent_changes`.
- [ ] KHÔNG có `create_*` / `update_*` / `delete_*` trong list (vì write=false).
- [ ] Log không có error auth với BookStack.

## Risks

- Container không pull được `ghcr.io` → check firewall VPS outbound 443.
- Token sai → tools/list vẫn work nhưng search trả 401. **Mitigate:** test search 1 keyword có thật.
- Startup log ra warning `INSECURE_SKIP_TLS_VERIFY=true` → sai config, fix ngay.

## Rollback

`docker compose stop bookstack-mcp && docker compose rm -f bookstack-mcp`. Không ảnh hưởng OneMCP.
