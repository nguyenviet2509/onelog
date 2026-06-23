# Phase 08 — MCP servers (Hybrid: official mcp-victorialogs + custom semantic)

## Context
- Plan: [plan.md](plan.md)
- Re-scope: [brainstorm Web+MCP §7](../reports/brainstorm-260622-1113-rag-web-ui-and-mcp-rescope.md)
- Official: https://github.com/VictoriaMetrics/mcp-victorialogs (Go, 86 stars, 12 tools)

## Overview
- Priority: P2 (sau MVP)
- Status: **MVP slice scaffolded 2026-06-23**. mcp-vl official đã trong compose (profile `mcp`). Custom `mcp-semantic` FastMCP scaffold xong với 1 tool `search_log_templates` (reuse Qdrant + embed mock-compat). Caddy route `/mcp/semantic/*` activated. Auth defer (Caddy IP whitelist guard, MCP_BEARER env placeholder). Deferred slice 2: Postgres bearer token table, Web settings UI sinh token, audit log source=mcp.
- Mục tiêu: 2 MCP server song song để IDE assistant (Claude Code/Desktop/Cursor) truy log:
  1. **`mcp-victorialogs` official** (Go) — 12 read-only tools cho LogsQL, discovery, stats
  2. **Custom FastMCP semantic** (Python) — 1 tool `search_log_templates` (Qdrant semantic, USP)
- PII đã redact ở Vector ingest pipeline (Phase 02) → mọi tool đọc VL trả data clean

## Why hybrid
- Official cover 95% LogsQL/discovery use case, maintained by VictoriaMetrics
- Semantic search trên template đã Drain3 dedupe + embed Qdrant là **USP riêng**, official không có
- Tốn thêm chỉ ~0.5 ngày code cho semantic MCP

## Architecture
```
Claude Desktop / Code / Cursor
   │
   ├── mcp/vl  → Caddy → mcp-victorialogs (Go, official)
   │              └── VictoriaLogs HTTP API
   │              tools: query, hits, facets, field_names, field_values,
   │                     stream_field_names, stream_field_values, stream_ids,
   │                     stats_query, stats_query_range, flags, documentation
   │
   └── mcp/semantic → Caddy → mcp-semantic (Python FastMCP, custom)
                              └── Qdrant (semantic search on templates)
                              tools: search_log_templates(query, filters)
```

## Official `mcp-victorialogs` setup

Đã thêm vào `infra/docker-compose.yml`:
```yaml
mcp-vl:
  image: victoriametrics/mcp-victorialogs:latest
  environment:
    VL_INSTANCE_ENTRYPOINT: http://victorialogs:9428
    MCP_TRANSPORT: sse
    MCP_LISTEN_ADDR: 0.0.0.0:8000
  ports:
    - "127.0.0.1:8001:8000"
```

Caddy route: `/mcp/vl/*` → `mcp-vl:8000`

Auth: dùng `MCP_PASSTHROUGH_HEADERS=Authorization` → Caddy forward Bearer từ user. Token verify Postgres `api_tokens` table (giống custom MCP).

## Custom semantic MCP

### Files (Python)
- `mcp-semantic/pyproject.toml`
- `mcp-semantic/src/mcp_semantic/main.py` (FastMCP entry, 1 tool)
- `mcp-semantic/src/mcp_semantic/auth.py` (Bearer verify Postgres)
- `mcp-semantic/src/mcp_semantic/qdrant_search.py` (import từ `agent.tools.search_log_templates`)
- `mcp-semantic/src/mcp_semantic/audit.py` (Postgres write source=mcp)
- `mcp-semantic/Dockerfile`

### Tool signature
```python
@mcp.tool()
async def search_log_templates(
    query: str,
    service: str | None = None,
    host: str | None = None,
    severity: str | None = None,
    time_range: str | None = None,  # "1h", "24h", "2026-06-22T10:00..11:00"
    limit: int = 10,
) -> list[dict]:
    """Semantic search over deduped log templates (Drain3 + embedding).
    Returns templates with metadata: service, host, severity, count, window, sample_redacted.
    Use when 'query' or 'hits' don't give relevant results due to fuzzy semantic intent."""
```

### docker-compose addition
```yaml
mcp-semantic:
  build: ./mcp-semantic
  environment:
    QDRANT_URL: http://qdrant:6333
    QDRANT_API_KEY: ${QDRANT_API_KEY}
    POSTGRES_URL: postgresql://...
    OPENAI_API_KEY: ${OPENAI_API_KEY}  # embedding
    MCP_LISTEN_ADDR: 0.0.0.0:9000
  ports:
    - "127.0.0.1:9001:9000"
```

Caddy uncomment `/mcp/semantic/*` route.

## User config Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "logserver-vl": {
      "url": "https://app.local/mcp/vl/sse",
      "headers": { "Authorization": "Bearer sk-mcp-..." }
    },
    "logserver-semantic": {
      "url": "https://app.local/mcp/semantic/sse",
      "headers": { "Authorization": "Bearer sk-mcp-..." }
    }
  }
}
```

Claude tự pick tool nào phù hợp với câu hỏi. Có thể disable `documentation` của official (resource-intensive) qua `MCP_DISABLED_TOOLS=documentation`.

## Implementation Steps
1. Deploy `mcp-victorialogs` official qua compose
2. Caddy route `/mcp/vl/*`
3. Test smoke: từ Claude Desktop config, hỏi "list services in last hour" → assert tool `field_values` được gọi
4. Build custom `mcp-semantic`:
   - Scaffold FastMCP project
   - Import `search_log_templates` từ agent module
   - Token auth Postgres
   - Audit writer (source=mcp_semantic)
5. Compose service `mcp-semantic`
6. Caddy route `/mcp/semantic/*`
7. Web settings page MCP setup tab: hiển thị config snippet 2 server
8. E2E test với Claude Desktop

## Todo
- [ ] Deploy mcp-victorialogs official compose
- [ ] Caddy /mcp/vl/* route
- [ ] Test 12 tool official từ Claude Desktop
- [ ] Scaffold mcp-semantic FastMCP
- [ ] Share `search_log_templates` từ agent
- [ ] Token Bearer auth Postgres
- [ ] Audit log
- [ ] Compose service mcp-semantic + Caddy /mcp/semantic
- [ ] Web settings UI snippet 2 server
- [ ] E2E test cả 2 server
- [ ] Doc mcp-setup-guide.md

## Success Criteria
- Official mcp-victorialogs: 12 tool callable từ IDE, query LogsQL trả data đã redact
- Custom semantic: tool `search_log_templates` callable, semantic relevant cao hơn LogsQL fuzzy
- Token revoke → cả 2 server reject
- Audit log có entry source=mcp_vl và source=mcp_semantic
- PII verify: inject log có email/IP nội bộ → tool trả về phải <EMAIL>/<PRIV_IP>

## Risks
- **Official MCP token leak**: VictoriaLogs Bearer token có thể bị abuse → quay token định kỳ, ưu tiên Caddy IP whitelist trước
- **Spec MCP evolve**: pin version `victoriametrics/mcp-victorialogs:vX.Y.Z` thay vì `latest`
- **PII regex miss**: Vector VRL redact đơn giản, review weekly sample. Consider Presidio sidecar nếu cần mạnh hơn
- **Tool overlap confusing LLM**: official có `query`, custom có `search_log_templates` — system prompt MCP cần hint khi nào dùng cái nào (đã làm trong docstring tool)

## Security
- 2 MCP server đều require Bearer, không anonymous
- Caddy IP whitelist giai đoạn auth defer
- Audit immutable trong Postgres
- Token expire 90d, revoke từ Web /settings
- Outbound: Anthropic API (do client IDE đã gọi)

## Next Steps
- Sau khi 2 MCP ổn, có thể expose thêm tool write (silence_alert, ack_alert) — cần role admin
- Theo dõi official mcp-victorialogs release để tận dụng tool mới
