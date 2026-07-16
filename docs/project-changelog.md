# OneLog Project Changelog

All notable changes to OneLog are documented here. Format: `YYYY-MM-DD [Type] Description`.

**Type abbreviations:**
- `feat` — New feature
- `fix` — Bug fix
- `perf` — Performance improvement
- `refactor` — Code refactoring
- `docs` — Documentation
- `infra` — Infrastructure / deployment

---

## 2026-07-16

**feat(kb): Knowledge Base Phase 1 shipped — Mark Resolved button in chat**

- New tables: `kb_entries`, `kb_edits`, `kb_taxonomy` (Postgres)
- New Qdrant collection: `kb_resolved` (separate from `log_templates`)
- API `POST /api/kb/summarize` — member chat → LLM (DeepSeek/Haiku) draft KB entry
- API `POST /api/kb/entries` — member review/edit → save entry (with semantic dedup)
- Chat UI: "Mark Resolved" button → modal review form → confirm → save
- Features:
  - Auto-classify department/topic/issue via LLM
  - Insert-time semantic dedup (cosine >0.9 → merge prompt)
  - Taxonomy snap-to-existing (fuzzy + semantic, threshold 0.85)
  - PII redaction before embedding
  - Audit trail via `kb_edits`
- Env vars: `DEEPSEEK_API_KEY`, `KB_SUMMARIZE_MODEL`, `EMBED_MODEL`, `OPENAI_API_KEY`, `KB_QDRANT_COLLECTION`, `KB_DEDUP_THRESHOLD`, `KB_SNAP_THRESHOLD`
- Next: Phase 2 — `/kb` browse tab with search + filters (pending)

---

## 2026-07-13

**feat(vmalert): Phase 1a deployment — 4 disk + 2 ops rules to prod**

- Deployed 4 disk-related alert rules (Warn + Critical thresholds)
- Deployed 2 ops monitoring rules (replication lag, indexer health check)
- vmalert rules stored in git; verified no drift post-deploy
- Phase 1b pending (Telegram notification consolidation)

---

## 2026-07-10

**feat(observability): Production readiness rotation script shipped**

- Automated rotation for Postgres WAL, Qdrant snapshots, backup cleanup
- Cron jobs validated on logserver; healthcheck integration

---

## 2026-07-09

**feat(dashboard): Cost dashboard for LLM providers shipped (Grafana)**

- Real-time cost tracking: Anthropic, OpenAI, DeepSeek, Gemini
- Admin key rotation SOP documented
- Optional feature (not required for Phase 1 MVP)

---

## 2026-06-25

**feat(ingest): Rsyslog JSON ingest pipeline shipped**

- Clients forward RFC5424 syslog via TCP 6514 → Vector → VictoriaLogs
- JSON field extraction (severity, service, host)
- Indexer processes raw logs → Qdrant log templates (Drain3)

---

## 2026-06-24

**perf(mcp): MCP-only pivot completed + Phase 01 smoke pass**

- Consolidated MCP services (mcp-vl, mcp-semantic) — FastAPI backends serving MCP specs
- Removed agent-only service layer (agent now backend for web chat only)
- Smoke tests: logs ingest → VL search → semantic search via Qdrant → chat SSE response
- All e2e verified on logserver lab setup

---

## 2026-06-23

**infra(rag): RAG log server MVP deployed (single-node lab)**

- Docker Compose stack: Vector → VictoriaLogs → Qdrant (logs embeddings) + Postgres + NATS + Indexer + Agent
- Caddy reverse proxy (IP whitelist, internal TLS for lab)
- Deployment guide published; 3-VM lab topology (srv-01/02 clients, logserver aggregator)
- Systemd auto-restart, daily snapshots, healthcheck script

---

## 2026-06

Project initialized. Research phase on log centralization strategy, MCP protocol, semantic search architecture.

---
