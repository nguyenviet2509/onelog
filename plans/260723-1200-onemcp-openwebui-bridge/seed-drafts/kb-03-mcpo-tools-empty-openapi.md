---
type: kb
tags: [mcpo, openwebui, healthcheck, boot-race]
service: mcpo
source: infra/docker-compose.yml comment (mcpo healthcheck)
---

# Title
mcpo trả 0 tools trong /openapi.json sau boot → OpenWebUI hallucinate tool name

## Problem / symptoms
Cold boot sau restart Docker: mcpo start trước khi `mcp-vl` hoặc `mcp-semantic` ready → mcpo discover 0 endpoints → `/openapi.json` rỗng vĩnh viễn (mcpo không auto-retry discovery).

Hệ quả: OpenWebUI thấy MCP server "up" nhưng không có tool → LLM tự bịa tên tool → tool call fail với error khó hiểu.

## Solution
Healthcheck trong `docker-compose.yml` cho mcpo đã ép: nếu bất kỳ upstream MCP có 0 paths → `kill 1` PID → `restart: unless-stopped` kick in → mcpo re-discover ở fresh process.

Nếu vấn đề tái diễn:
1. `docker compose --profile chat restart mcpo` (manual kick)
2. Verify:
```bash
curl -s http://127.0.0.1:8091/onelog-vl/openapi.json | jq '.paths | keys | length'
curl -s http://127.0.0.1:8091/onelog-semantic/openapi.json | jq '.paths | keys | length'
# Cả 2 phải > 0
```
3. Nếu vẫn 0: check upstream `docker compose logs mcp-vl mcp-semantic --tail=30`

## Root cause
mcpo library (as of `main` tag) discover MCP tools qua tools/list JSON-RPC 1 lần duy nhất tại startup. Nếu upstream chưa healthy → empty paths → không retry cho tới next process restart.

## Related
- docker-compose.yml section `mcpo` (healthcheck logic + comment)
- OpenWebUI MCP setup: `docs/mcp-setup-guide.md`
