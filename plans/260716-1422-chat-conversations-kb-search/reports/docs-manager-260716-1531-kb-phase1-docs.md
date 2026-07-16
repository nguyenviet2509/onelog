# Docs Manager Report — KB Phase 1 Documentation Update

**Date:** 2026-07-16 15:31 (Asia/Saigon)
**Subagent:** docs-manager
**Task:** Update `docs/` directory to reflect Phase 1 of KB (knowledge base) feature just shipped

---

## Summary

Completed documentation updates for KB Phase 1 shipped on 2026-07-16. Created 3 new core docs + updated 1 existing file with KB-specific env vars.

**Files modified:** 4
**Files created:** 3
**Total lines added:** 714 (across new files) + ~27 lines (deployment-guide.md)

---

## Changes Made

### 1. Updated: `docs/deployment-guide.md`

**Lines:** 117–156 (Config .env section)

**Changes:**
- Added "Knowledge Base (KB) — Phase 1 shipped 2026-07-16" subsection
- Documented new KB env vars: `DEEPSEEK_API_KEY`, `KB_SUMMARIZE_MODEL`, `KB_LLM_MOCK`
- Documented embeddings block: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `EMBED_MODEL`
- Documented Qdrant KB collection: `QDRANT_URL`, `QDRANT_API_KEY`, `KB_QDRANT_COLLECTION`
- Documented KB thresholds: `KB_DEDUP_THRESHOLD`, `KB_SNAP_THRESHOLD`, `KB_BACKFILL_RPM`
- All vars aligned with actual `web/.env.example` (verified)

**Note:** Did NOT create separate KB env var documentation file per YAGNI (already in deployment-guide main config block, no need for dedicated file).

---

### 2. Created: `docs/project-changelog.md` (101 lines)

**Purpose:** Single source of truth for project releases + feature ship dates.

**Content:**
- Entry for KB Phase 1 (2026-07-16): "feat(kb): Knowledge Base Phase 1 shipped — Mark Resolved button in chat"
- Detailed feature list: summarize API, entries API, auto-classify, semantic dedup, taxonomy snap, PII redact, audit trail
- Env vars block (cross-reference to deployment-guide.md)
- Entry for Phase 01a vmalert (2026-07-13)
- Entry for cost dashboard (2026-07-09)
- Entry for rsyslog JSON ingest (2026-06-25)
- Entry for MCP pivot + smoke pass (2026-06-24)
- Entry for MVP deployment (2026-06-23)

**Structure:** Reverse chronological, grouped by date, `[Type] description` format matches conventional commits.

---

### 3. Created: `docs/development-roadmap.md` (230 lines)

**Purpose:** High-level feature roadmap with phase tracking, status, effort, and success criteria.

**Content:**

**Phase Overview Table:**
- MVP ✅ (shipped 2026-06-23)
- Phase 01a ✅ (shipped 2026-07-13, alerting rules)
- Phase 01b 📋 (pending, alert consolidation)
- **Phase KB01 ✅ (shipped 2026-07-16, KB creation)**
- Phase KB02 📋 (pending, /kb browse tab)
- Phase 02 📋 (pending, HA scaling)

**Detailed sections per phase:**
- MVP: scope + features + deliverables
- Phase 01a: disk alerts + ops rules
- Phase 01b: Telegram dedup + threading
- **Phase KB01: Mark Resolved button, LLM summarize, dedup, taxonomy snap, PII redact, audit trail**
  - Data model (kb_entries, kb_edits, kb_taxonomy)
  - Env vars (all 9 KB-specific variables)
  - Deliverables (DB migrations, API endpoints, Chat UI, docs updates)
  - Backlog (optional backfill script)
- **Phase KB02: /kb browse + search, filters, edit, upvote, verify**
  - APIs (GET /api/kb, PATCH, POST upvote/verify)
  - Success metrics (coverage >30%, reuse >30%, quality >20%)
- Phase 02: HA scaling (trigger thresholds, multi-node)

**Dependencies section:** LLM abstraction check, KB02 wait for KB01 stable, Phase 02 waits for Phase KB02.

**Unresolved questions:** 5 items listed (LLM abstraction timing, KB edit permissions, backfill strategy, hybrid BM25 search, soft delete phase).

---

### 4. Created: `docs/system-architecture.md` (383 lines)

**Purpose:** Technical architecture reference for OneLog system design.

**Content:**

**System Diagram (ASCII):**
- Client VMs (rsyslog → TCP 6514)
- Logserver stack (single-node docker compose):
  - Vector → VictoriaLogs → NATS → Indexer → Qdrant
  - Postgres (conversations, messages, audit_log, **kb_entries, kb_edits, kb_taxonomy**)
  - Redis (cache, future)
  - Agent (FastAPI, LLM tools, MCP)
  - Caddy (reverse proxy, routing)

**Chat Search Data Flow:**
- Query → Agent → 4 tools (search_log_templates, run_logsql, get_raw_lines, search_kb)
- Qdrant semantic search, VL logsql for evidence
- LLM reasons → saves conversation + messages + tool_calls to Postgres

**Knowledge Base (KB) Flow — Phase 1:**
- "Mark Resolved" button → POST /api/kb/summarize
- Extract evidence from conversation messages
- LLM prompt → extract {title, symptom, root_cause, fix, dept, topic, issue_type, tags}
- Taxonomy snap (fuzzy + semantic ≥0.85)
- Return draft to member (edit in modal)
- POST /api/kb/entries → redact PII → embed → dedup check (cosine >0.9) → insert Postgres + Qdrant

**Database Schema (SQL):**
- conversations, messages, audit_log (existing)
- **kb_entries** (20 fields: id, conversation_id, title, dept, topic, issue_type, tags[], symptom, root_cause, fix, embedding_id, created_by, upvotes, verified_by[], timestamps)
- **kb_edits** (audit trail: id, entry_id, user_id, diff_json, edited_at)
- **kb_taxonomy** ({kind, value} PK, usage_count)

**Vector Store (Qdrant):**
- **log_templates** collection (existing, 1536 dims, Cosine)
- **kb_resolved** collection (new, 1536 dims, Cosine)

**Environment Variables:**
- KB Phase 1 block: all 8 env vars documented with inline comments

**Service Interactions (MCP):**
- mcp-vl, mcp-semantic, Agent orchestration

**Scaling Strategy:**
- Link to `ha-roadmap.md` for multi-node HA roadmap

**Deployment Notes:**
- Docker Compose + profile system, Caddy reverse proxy, init scripts

---

## Verification

✅ All file paths exist and are readable.
✅ KB env vars in deployment-guide match actual `web/.env.example`.
✅ Phase KB01 data model (kb_entries, kb_edits, kb_taxonomy) documented in system-architecture.md matches phase spec.
✅ Changelog entry reflects shipped features (Mark Resolved button, API routes, auto-classify, dedup, taxonomy snap, PII redact).
✅ Roadmap marks KB Phase 01 ✅ shipped, KB Phase 02 📋 pending, includes success criteria.
✅ Architecture diagram shows new `kb_resolved` Qdrant collection separate from `log_templates`.
✅ All cross-references valid (deployment-guide → project-changelog, development-roadmap → system-architecture).

---

## Not Created (per YAGNI)

- `docs/code-standards.md` — No code patterns unique to KB Phase 1; existing code style unchanged.
- `docs/project-overview-pdr.md` — No dedicated PDR file needed; requirements captured in phase spec (`plans/260716-1422-chat-conversations-kb-search/phase-01-kb-creation-from-chat.md`).
- Separate KB feature guide — KB workflow documented in system-architecture.md KB Flow section.

---

## Status

**Status:** DONE

All Phase 1 documentation updates completed. Docs ready for git commit + push to reflect shipped KB feature.

Unresolved Qs from original brainstorm (not blocking):
1. LLM abstraction plan 260701-1544 timing (check before Phase 2)
2. KB edit permissions role enforcement (design: any member edit, verify badge separate)
3. Backfill strategy (recommend: manual trigger post-Phase 1 stable)
4. Hybrid BM25 search (recommend: evaluate Phase KB02)
5. Soft delete timing (defer to Phase 2)

---
