# OneLog Development Roadmap

High-level feature map. Phases track MVP completion → production readiness → advanced features.

**Last updated:** 2026-07-16

---

## Phase Overview

| Phase | Timeline | Status | Goal |
|-------|----------|--------|------|
| **MVP** | 2026-06–07 | ✅ Shipped | Single-node log centralization (syslog → VL → RAG chat) |
| **Phase 01a** | 2026-07-13 | ✅ Shipped | Alerting rules + monitoring (disk, ops) |
| **Phase 01b** | Pending | 📋 Planned | Telegram alert consolidation |
| **Phase KB01** | 2026-07-16 | ✅ Shipped | Knowledge Base creation from chat (Mark Resolved button) |
| **Phase KB02** | Pending | 📋 Planned | KB browse + search tab (`/kb` route) |
| **Phase 02** | Pending | 📋 Planned | Multi-node HA (VL + Qdrant + Postgres cluster) |

---

## Shipped · MVP (2026-06-23)

**Scope:** Single-node RAG log server with chat interface.

**Features:**
- Log ingest: syslog RFC5424 (TCP 6514) from N clients → Vector → VictoriaLogs
- Semantic indexing: raw logs → Drain3 templates → Qdrant embeddings
- Chat interface: Next.js web UI + FastAPI agent backend (SSE)
- Search: hybrid logsql + semantic query (cite tool_calls)
- Alerts: vmalert rules → Alertmanager → Telegram (optional)
- Deployment: Docker Compose, systemd auto-restart, daily snapshots

**Deliverables:**
- `docs/deployment-guide.md` — lab setup (3-VM topology)
- `infra/docker-compose.yml` + profile system (agent, mcp, alerts, indexer)
- Healthcheck + snapshot scripts

---

## Shipped · Phase 01a (2026-07-13)

**Scope:** Alerting rules for production readiness.

**Features:**
- 4 disk-related alert rules (Warn/Crit)
- 2 ops monitoring rules (replication lag, indexer health)
- vmalert configuration in git (no manual edits on server)

**Deliverables:**
- `infra/vmalert/rules.yml`
- `docs/deployment-guide.md` section on disk alert verification

---

## In Progress · Phase 01b (Pending)

**Scope:** Consolidate alert notifications via Telegram.

**Features:**
- Dedup alert storms (same alert, burst → 1 message + counter)
- Threading in Telegram topics (per severity / service)
- Alert acknowledge / silence from Telegram callback buttons

**Dependencies:**
- Alertmanager webhook + Telegram bot state (Redis)

**Target:** TBD (after Phase KB02)

---

## Shipped · Phase KB01 (2026-07-16)

**Scope:** Knowledge Base creation from resolved chat conversations.

**Features:**
- Button "Mark Resolved" in conversation view
- LLM (DeepSeek/Haiku) summarize chat → entry draft
- Member review/edit inline → POST save
- Auto-classify: department, topic, issue_type
- Semantic dedup at insert: cosine >0.9 → merge prompt
- Taxonomy snap-to-existing: fuzzy + semantic match (≥0.85)
- PII redaction before embedding
- Audit trail (`kb_edits` table)

**Data model:**
- `kb_entries` — id, conversation_id (nullable), title, department, topic, issue_type, tags[], symptom, root_cause, fix, embedding_id, created_by, upvotes, verified_by[], created_at, updated_at
- `kb_edits` — audit trail: id, entry_id, user_id, diff_json, edited_at
- `kb_taxonomy` — (kind, value) PK, usage_count

**Env vars:**
- `DEEPSEEK_API_KEY`, `KB_SUMMARIZE_MODEL`, `EMBED_MODEL`, `OPENAI_API_KEY`
- `QDRANT_URL`, `QDRANT_API_KEY`, `KB_QDRANT_COLLECTION`
- `KB_DEDUP_THRESHOLD`, `KB_SNAP_THRESHOLD`, `KB_LLM_MOCK`, `KB_BACKFILL_RPM`

**Deliverables:**
- DB migrations + schema in `web/src/db/schema.ts`
- `POST /api/kb/summarize` endpoint
- `POST /api/kb/entries` endpoint (with dedup response)
- Chat UI: "Mark Resolved" button + review modal
- `docs/deployment-guide.md` updated with KB env vars
- `docs/project-changelog.md` created with KB01 entry

**Backlog (post-stable):**
- Optional: `scripts/kb-backfill.ts` to summarize existing conversations

---

## Pending · Phase KB02

**Scope:** KB browse + search interface.

**Features:**
- Page `/kb` — search box, cascade filters (dept → topic → issue_type)
- Page `/kb/[id]` — full entry view + edit + upvote + verify
- Search: hybrid BM25 + semantic (Qdrant + optional Postgres tsvector)
- Inline edit → `kb_edits` audit trail
- Upvote / Verify buttons
- Badge for verified entries (≥1 verified user) or popular (≥3 upvotes)
- Link source conversation (if `conversation_id` set)

**APIs:**
- `GET /api/kb?dept=&topic=&issue=&q=&limit=` (search + filters)
- `PATCH /api/kb/:id` (edit)
- `POST /api/kb/:id/upvote` (toggle upvote)
- `POST /api/kb/:id/verify` (toggle verify — admin only or any member?)

**Effort:** ~1 week after KB01 stable

**Success metrics:**
- Coverage: >30% conversations → KB entry (1 month)
- Reuse: >30% new chat queries match KB >0.7 cosine
- Quality: >20% entries verified or ≥3 upvotes
- Time saved: median >15 min per incident (self-reported)

---

## Pending · Phase 02 (HA Scaling)

**Scope:** Multi-node HA for production SLA >99.9%.

**Trigger thresholds:**
- Log volume > 200 GB/day (VL cluster)
- Qdrant collection > 50M vectors
- Indexer lag > 5 min sustained
- >10 concurrent sysadmins
- LLM cost > $1k/month

**Components:**
- VictoriaLogs cluster (vlinsert×N → vlstorage×2 replica → vlselect×N)
- Qdrant cluster (3 node, `replicas=2`, snapshot to S3)
- Postgres HA (primary + replica, WAL ship)
- NATS cluster (3 node, JetStream `replicas=3`)
- Indexer×N with shared Drain3 state in Redis
- Agent scale (behind LB, Redis semantic cache, multi-key LLM rotation)
- Load balancer (Caddy / nginx)

**Effort:** 4–6 weeks (after Phase KB02)

**Deliverables:**
- Docker Compose → Kubernetes (or enhanced Compose with clustering scripts)
- HA deployment guide
- Backup + DR procedures (restore drill SLA)
- Monitoring dashboard (VictoriaMetrics + Grafana)

---

## Deferred (Not MVP)

- **Telegram-KB integration** — KB link in alerts, sidebar auto-suggest
- **Grafana tooltip** — KB result in Grafana when hovering metrics
- **Auto-curate conversations** — Nightly scan idle >24h conv → KB entry
- **KB versioning** — Soft delete + full history (audit trail enough for MVP)
- **Multi-language support** — KB entries currently Vietnamese; i18n deferred
- **KB permissions** — All members can edit; role-based ACL post-Phase 2
- **Export features** — PDF/Excel for KB (Phase 3)

---

## Dependencies & Blockers

| Phase | Blocker | Status | ETA |
|-------|---------|--------|-----|
| KB01 | LLM provider abstraction (plan 260701-1544) | 🟡 Check before Phase 2 | TBD |
| KB02 | KB01 stable + user feedback | ⏳ Waiting | Post-KB01 |
| Phase 02 | KB01 + 01b + volume >100 GB/day | 📋 Planning | Q3 2026 |

---

## Success Criteria (per phase)

**MVP:**
- [x] E2E ingest → search → chat working on lab
- [x] Healthcheck 100% pass
- [x] Snapshot/restore verified
- [x] Team comfortable with UX

**Phase 01a:**
- [x] Disk alert rules deployed + verified
- [x] No manual edits post-deploy (IaC)

**Phase KB01:**
- [ ] Member bấm "Mark Resolved" → draft <10s
- [ ] Dedup detect duplicates (test with 2 similar convos)
- [ ] PII redaction verified (no IP/hostname in Qdrant payload)
- [ ] 50+ entries in KB (manual creation + optional backfill)
- [ ] Smoke test: search KB >0.7 cosine match for known case

**Phase KB02:**
- [ ] Search latency <1s (Qdrant filter + Postgres tsvector hybrid)
- [ ] Cascade filters respond <100ms
- [ ] Upvote/verify buttons increment counters correctly
- [ ] Edit → `kb_edits` audit trail accurate

**Phase 02:**
- [ ] Cluster parity check <1% delta vs single-node
- [ ] Failover time <5 min (vlstorage replica takeover)
- [ ] No data loss during planned cutover

---

## Unresolved Questions

1. **LLM abstraction timing:** Plan 260701-1544 blocks multi-provider support in KB01. Fallback: hardcode DeepSeek in Phase 1, refactor Phase 2?
2. **KB edit permissions:** Should only admin verify entries, or any member? (Currently design: any member can edit, ≥1 verified → badge.)
3. **Backfill strategy:** Manual trigger after Phase 1 stable, or auto on deploy?
4. **Hybrid search BM25:** Use Postgres `tsvector` or just Qdrant semantic filter by dept/topic?
5. **KB soft delete:** Include in Phase 1 or Phase 2?

---
