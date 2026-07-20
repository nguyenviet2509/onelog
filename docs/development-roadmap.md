# Development Roadmap

## KB Module

**Superseded 2026-07-17** — KB workflow moved to OpenWebUI native (Notes + Knowledge). All `/api/kb/*` endpoints listed below are historical planning artifacts and will not be implemented. Retained for reference in case a bespoke KB service is resurrected.

### KB Phase 01: OpenWebUI Integration (KB01)

**Status:** ✅ **Complete** (2026-07-16)

OpenWebUI-driven KB entry creation: mark chat → draft → review → commit → vector store.

**Features:**
- OpenWebUI Function ("Mark Resolved" button)
- LLM-generated drafts (DeepSeek or mock)
- Draft review form (server-rendered Next.js page)
- PII redaction (6-pattern regex)
- Semantic deduplication (Qdrant similarity)
- Taxonomy auto-snap (topic, issue_type)
- Rate limiting (20/user/day)

**Env vars required:** See [deployment-guide.md](deployment-guide.md) → "KB Phase 1 env vars"

**Known limitations (Phase 2):**
- No draft manual cleanup scheduling (skeleton route; external cron needed)
- No KB entry edit UI (audit log schema exists)
- No manual entry creation (schema supports nullable `openwebui_chat_id`, not yet used)

---

### KB Phase 02: Draft Cleanup & Verification (KB02)

**Status:** 📋 Pending

**Goal:** Finalize cleanup cron + add verification UI for knowledge gaps.

**Tasks:**
1. Schedule cleanup cron: systemd timer or `pg_cron` extension (prod decision)
2. Verification endpoint: GET `/api/kb/entries?depth=verified` — list entries by verify count
3. Verify UI: simple list + checkmark (avoids full edit workflow for Phase 2)
4. Metrics: track verify rates per department

**Acceptance criteria:**
- Expired drafts deleted within 5 min of TTL expiry
- Verification UI loads < 1s
- Metrics emitted to VictoriaLogs

---

### KB Phase 03: Manual Entry Creation (KB03)

**Status:** 📋 Pending

**Goal:** Allow team members to author KB entries without a chat conversation.

**Tasks:**
1. POST `/api/kb/entries` (no draft) — require `openwebui_jwt` only
2. Auto-generate `openwebui_chat_id` if null (or require token)
3. Rate limit check same as drafts
4. Dedup check mandatory (no force bypass)

**Acceptance criteria:**
- Entry created without summarize step
- Dedup blocks low-effort duplicate prevention
- Audit log captures manual creation

---

### KB Phase 04: Taxonomy Management (KB04)

**Status:** 📋 Pending

**Goal:** UI + admin API for curating department, topic, issue_type values.

**Tasks:**
1. GET `/api/kb/taxonomy` — list all values + usage_count
2. POST `/api/kb/taxonomy` (admin) — add new value
3. DELETE `/api/kb/taxonomy/{id}` (admin) — mark retired (no hard delete)
4. Taxonomy UI: department page (filter / sort by usage)

**Acceptance criteria:**
- Taxonomy CRUD tested
- Usage counts accurate (bump on entry insert, not snap)
- No orphaned taxonomy values

---

### KB Phase 05: Search & Retrieval (KB05)

**Status:** 📋 Pending

**Goal:** Expose KB retrieval for agent `/chat` or user search interface.

**Tasks:**
1. GET `/api/kb/search?q=...` — semantic search via Qdrant
2. Return top-K with similarity + metadata (title, issue_type, department)
3. Optional: rank by department if user context available
4. Cache results (Redis) for high-frequency queries

**Acceptance criteria:**
- Search returns relevant results (manual QA: 80% precision on 20 queries)
- Latency < 500ms (including Qdrant call)
- Caching reduces repeat-query latency by 90%

---

### KB Phase 06: Analytics & Dashboard (KB06)

**Status:** 📋 Pending

**Goal:** Visibility into KB usage, author contributions, coverage gaps.

**Tasks:**
1. Dashboard: entries/day, summarize calls/day, dedup hit rate, department breakdown
2. Author leaderboard: top verifiers, top editors
3. Gap analysis: departments / topics with low entry counts
4. Metrics: emit to VictoriaLogs (via web service logging)

**Acceptance criteria:**
- Dashboard loads < 2s
- Charts update every 1 hour
- 30-day historical retention (VL default)

---

### KB Phase 07: Advanced Features (KB07)

**Status:** 📋 Pending (stretch)

**Goal:** Edge-case handling and integration polish.

**Tasks:**
1. Batch import: accept CSV of entries (manual creation bulk)
2. Export: download KB as PDF (per department or all)
3. Redaction improvements: learn new PII patterns from user feedback
4. LLM variant: support multiple summarize models (per-user preference)

**Acceptance criteria:**
- Batch import < 10min for 1000 entries
- PDF export < 5s for 100 entries
- Pattern feedback captured + verified before auto-deploy

---

## Other modules (non-KB)

### Log Server (core stack)

**Status:** ✅ Deployed (logserver-01)

- Vector (syslog TCP 6514 + UDP 514)
- VictoriaLogs (7d retention, logsql query)
- Qdrant (semantic templates)
- Postgres (metadata, KB tables)
- Redis (cache, rate-limit)
- Indexer (Drain3 log templates → Qdrant)
- Agent (chat, SSE)
- Caddy (reverse proxy, TLS lab)
- vmalert (disk alerts, Telegram)

See [deployment-guide.md](deployment-guide.md) for topology and setup.

---

### LLM Abstraction (LiteLLM + OpenWebUI)

**Status:** ✅ Optional / Deployed on-demand

See [deployment-llm-abstraction.md](deployment-llm-abstraction.md) for details.

---

### Cost Dashboard

**Status:** ✅ Optional / Available

See [cost-dashboard.md](cost-dashboard.md) for setup.

---

## Milestones & timeline

| Milestone | Target | Status |
|-----------|--------|--------|
| KB01 (Phase 1 OpenWebUI) | 2026-07-16 | ✅ Done |
| KB02 (Cleanup + verify) | 2026-08-01 | 📋 Planned |
| KB03 (Manual entry) | 2026-08-15 | 📋 Planned |
| KB04 (Taxonomy admin) | 2026-09-01 | 📋 Planned |
| KB05 (Search) | 2026-09-15 | 📋 Planned |
| KB06 (Dashboard) | 2026-10-01 | 📋 Planned |
| All KB phases prod-ready | 2026-10-31 | 📋 Target |

---

## Related documentation

- [system-architecture.md](system-architecture.md) — KB flow diagram and schema
- [project-changelog.md](project-changelog.md) — 2026-07-16 KB01 completion entry
- [deployment-guide.md](deployment-guide.md) — Env vars and deployment steps
