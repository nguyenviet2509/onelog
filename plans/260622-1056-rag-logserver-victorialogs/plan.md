---
name: rag-logserver-victorialogs
status: pending
created: 2026-06-22
updated: 2026-06-22
owner: trihd@inet.vn
blockedBy: []
blocks: []
relatedReports:
  - plans/reports/brainstorm-260622-1056-rag-logserver-victorialogs.md
  - plans/reports/brainstorm-260622-1113-rag-web-ui-and-mcp-rescope.md
  - plans/reports/brainstorm-260622-1556-rag-internal-deployment.md
relatedPlans:
  - plans/260618-1624-rag-victorialogs-system
---

# Plan: RAG Log Server (Single-node MVP, Web UI primary + MCP)

## Mục tiêu
Triển khai RAG log server single-node: VictoriaLogs + Vector.dev + Qdrant + Postgres + Claude Sonnet + Web UI Next.js (Q&A + trace + admin), Telegram chỉ alert push, MCP server Phase 08 cho IDE assistant.

## Context
- Design gốc: [brainstorm](../reports/brainstorm-260622-1056-rag-logserver-victorialogs.md)
- Re-scope Web+MCP: [brainstorm](../reports/brainstorm-260622-1113-rag-web-ui-and-mcp-rescope.md)
- Internal deployment context: [brainstorm](../reports/brainstorm-260622-1556-rag-internal-deployment.md)
- Scale: 50-200 server, 10-100GB log/ngày, 2-3 sysadmin
- LLM: Claude Sonnet + OpenAI embedding
- Vector DB: Qdrant single-node, Postgres cho metadata/conversation/audit
- UX: Web primary (Next.js + shadcn/ui), Telegram alert one-way, MCP secondary
- **Deployment**: nội bộ phòng kỹ thuật, OpenVPN-only access. Domain + SSL cert do công ty cấp sau (defer infra, focus app)
- **Auth defer**: MVP không user login (anonymous session). SSO + per-user audit ở Phase 09 sau MVP
- **LLM egress**: app proxy-aware (`HTTPS_PROXY` env) — swap direct/proxy không cần code change
- **Internal API integration**: tool registry stub ở Phase 03, implement ở Phase 03.5 khi chốt priority

## Phases

| # | Phase | Status | Dependency |
|---|---|---|---|
| 01 | [Hạ tầng VM + docker-compose + VictoriaLogs + Qdrant + Postgres + Caddy](phase-01-infrastructure-base.md) | **DONE** (verified 2026-06-23) | — |
| 02 | [Vector pipeline + Drain3 + Redaction + Indexer](phase-02-log-ingestion-indexer.md) | **DONE** (verified 2026-06-23) | 01 |
| 03 | [RAG Agent FastAPI + tool-use loop + Sonnet + auth stub](phase-03-rag-agent-service.md) | **MVP DONE** (2026-06-23) | 02 |
| 04 | [Web app Next.js (chat + trace + admin + settings)](phase-04-web-app-nextjs.md) | **MVP DONE** (chat only, 2026-06-23) | 03 |
| 05 | [Eval harness 20 cases + UI trigger](phase-05-eval-and-tuning.md) | pending | 04 |
| 06 | [Alertmanager + Telegram alert bot minimal](phase-06-alertmanager-integration.md) | **MVP DONE** (2026-06-23) | 01 (song song 02-05) |
| 07 | [HA roadmap doc](phase-07-ha-roadmap.md) | pending | 05 |
| 08 | [MCP server (FastMCP) expose tools cho Claude Code/Desktop](phase-08-mcp-server.md) | **MVP scaffolded** (2026-06-23) | 04, 05 |
| 03.5 | Internal API adapters (Jira/GitLab/Metrics/CMDB) — stub interface ở Phase 03, wire khi chốt priority | deferred | 03 |
| 09 | SSO + per-user audit (OIDC corp IdP) — plug auth thật thay anonymous session | deferred | 04 |

## Critical Path
01 → 02 → 03 → 04 → 05 → 07. Phase 06 song song sau 01. Phase 08 sau MVP (04+05 xong).

## Timeline (re-scoped MVP)
- Phase 01: 2-3 ngày
- Phase 02: 4-5 ngày
- Phase 03: 6-8 ngày
- Phase 04: **6-9 ngày** (giảm từ 10-14 nhờ embed vmui thay tự code trace)
- Phase 05: 4-5 ngày
- Phase 06: 2-3 ngày (song song)
- Phase 07: 1 ngày
- **MVP**: ~4-5 tuần (giảm ~1 tuần nhờ vmui)
- Phase 08: +1-2 ngày sau MVP

## Success Criteria
- Web uptime ≥ 99%, chat p95 < 8s 1-turn, < 15s multi-turn
- Trace page load < 2s với 10k log lines
- Recall RCA ≥ 80%, hallucination < 2%, drain3 unmatched < 5%
- Cost LLM < $200/tháng MVP
- MCP tool call work từ Claude Desktop/Code, latency < 5s

## Risks
- Auth defer → Web không auth = phải VPN nghiêm túc đến khi plug SSO Phase 09
- VPN compromise + no auth → mọi user VPN xem hết conversation. Mitigation: push Phase 09 sớm sau MVP
- LLM egress unknown (direct vs proxy) → app proxy-aware để swap không tốn dev time
- Frontend skill gap → fallback FastAPI+HTMX nếu team Python-only
- Postgres SPOF → snapshot daily
- MCP spec evolve → pin version
