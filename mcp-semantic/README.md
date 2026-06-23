# onelog mcp-semantic

FastMCP server exposing **one tool**: `search_log_templates` — semantic search over Drain3-clustered log templates in Qdrant.

Pair with the official `victoriametrics/mcp-victorialogs` (LogsQL / discovery / stats). Together they give IDE assistants (Claude Desktop / Code / Cursor) full read access to the onelog stack.

## Why a separate server (not part of agent)
- MCP protocol expects a dedicated process per server entry in client config
- Different lifecycle / restart semantics from chat agent
- Smaller blast radius for IDE-driven traffic

## Run via compose

```bash
cd infra
docker compose --profile mcp up -d --build mcp-vl mcp-semantic
```

Endpoints (behind Caddy):
- `http://<logserver>/mcp/vl/sse`        — official, 12 tools (LogsQL, hits, facets, ...)
- `http://<logserver>/mcp/semantic/sse`  — custom, semantic template search

## Claude Desktop config

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "onelog-vl": {
      "url": "http://<logserver-ip>/mcp/vl/sse"
    },
    "onelog-semantic": {
      "url": "http://<logserver-ip>/mcp/semantic/sse"
    }
  }
}
```

Restart Claude Desktop. The two servers' tools become available to Claude when chatting.

## Env

| Var | Default | Notes |
|---|---|---|
| `QDRANT_URL` | `http://qdrant:6333` | |
| `QDRANT_COLLECTION` | `log_templates` | Must match indexer |
| `OPENAI_API_KEY` | — | Required unless `EMBED_MOCK=true` |
| `EMBED_MOCK` | `false` | Hash vectors for offline/dev |
| `MCP_BEARER` | — | Placeholder — auth deferred to Caddy IP whitelist in MVP |

## Auth (MVP)
- **Lab**: rely on Caddy `remote_ip` allow list. No bearer enforced.
- **Production**: enable bearer middleware + Postgres token table (deferred slice).

## File layout

- `src/mcp_semantic/main.py` — FastMCP setup + the single tool
- `src/mcp_semantic/embed.py` — query → vector (OpenAI or hash mock)
- `src/mcp_semantic/config.py` — env settings
- `Dockerfile` — multi-stage
