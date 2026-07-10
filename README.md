# OneLog

RAG-powered log server + LLM chat stack. Centralizes syslog/rsyslog JSON logs from fleet servers, clusters templates via Drain3, embeds into Qdrant, and lets ops chat with logs via OpenWebUI + MCP tools (semantic search + LogsQL).

## Topology

```
   servers  ──rsyslog──▶  Vector  ──▶  VictoriaLogs   (raw + indexed logs)
                            │
                            └──WARN+──▶  NATS  ──▶  Indexer  ──embed──▶  Qdrant
                                                       │                    │
                                                       ▼                    │
                                                    vmalert                 │
                                                       │                    ▼
                                                       ▼             mcp-semantic
                                                 Alertmanager              │
                                                       │           mcp-vl  │
                                                       ▼                   │
                                                    Telegram   ◀── OpenWebUI ──▶ LiteLLM (4 providers)
```

## Services

| Service | Purpose | Profile |
|---|---|---|
| `victorialogs` | Log storage + LogsQL | default |
| `qdrant` | Vector store for log-template embeddings | default |
| `postgres` | Metadata / audit / cost logs | default |
| `vector` | Log shipper + parser | default |
| `nats` | JetStream — Vector→Indexer bus | default |
| `indexer` | Drain3 cluster + embed + upsert Qdrant | `indexer` |
| `mcp-semantic` | FastMCP — `search_log_templates` over Qdrant | default |
| `mcp-vl` | Official MCP for VictoriaLogs (LogsQL/discovery) | default |
| `mcpo` | MCP → OpenAPI bridge for OpenWebUI | `chat` |
| `openwebui` | Team chat UI | `chat` |
| `litellm-proxy` | OpenAI-compatible gateway to 4 providers | `llm`, `chat` |
| `agent` | FastAPI /chat service (LiteLLM SDK) | `agent` |
| `vmalert` | LogsQL alerting | `alerts` |
| `alertmanager` | Dedupe/route → Telegram | `alerts` |
| `grafana` | LLM cost dashboard | `dashboard` |
| `caddy` | TLS + reverse proxy + CIDR gate | default |
| `sqlite-web` | Read-only browser for OpenWebUI DB | `dbtools` |
| `redis` | Agent cache | `agent` |

## Quick start (LAN lab)

```bash
cd infra
cp .env.example .env               # fill secrets
docker compose up -d                # default profile
docker compose --profile chat --profile llm --profile alerts --profile dashboard up -d
```

Then browse `http://app.local/` — see [docs/deployment-guide.md](docs/deployment-guide.md) for full flow, prerequisites, DNS/Caddy setup, and prod checklist.

## Documentation

- **[docs/deployment-guide.md](docs/deployment-guide.md)** — full deploy runbook, .env template, troubleshooting, rollback.
- [docs/deployment-llm-abstraction.md](docs/deployment-llm-abstraction.md) — LiteLLM proxy setup (Phase 2).
- [docs/cost-dashboard.md](docs/cost-dashboard.md) — Grafana cost dashboard ops.
- [docs/llm-provider-ops.md](docs/llm-provider-ops.md) — multi-provider management.
- [docs/mcp-setup-guide.md](docs/mcp-setup-guide.md) — MCP client registration.
- [docs/openwebui-user-guide.md](docs/openwebui-user-guide.md) — end-user docs.
- [docs/ops-cheatsheet.md](docs/ops-cheatsheet.md) — quick reference commands.
- [docs/ha-roadmap.md](docs/ha-roadmap.md) — HA/scale roadmap.
- [docs/onelog-team-project-guide.md](docs/onelog-team-project-guide.md) — team workflow.

## Repo layout

```
onelog/
├─ agent/          FastAPI /chat service (Python, LiteLLM SDK)
├─ web/            Next.js frontend (decommissioned 2026-06-24 — kept for resurrect)
├─ indexer/        NATS→Drain3→Qdrant worker (Python)
├─ mcp-semantic/   FastMCP server for semantic log-template search
├─ infra/          docker-compose + Caddy + Vector + vmalert + Alertmanager + Grafana
├─ docs/           Ops docs
├─ mockups/        HTML architecture mockups (design artifacts)
└─ plans/          Internal planning + agent reports
```

## Production readiness

Latest audit: [plans/reports/audit-260710-0854-prod-readiness-full.md](plans/reports/audit-260710-0854-prod-readiness-full.md).

Before public-domain deploy: pin image tags in `infra/.env`, enable Caddy `auto_https`, replace `app.local` references with real FQDN, set Grafana `cookie_secure=true`.

## License

Internal use. See individual service directories for third-party notices.
