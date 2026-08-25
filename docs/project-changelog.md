# Project Changelog

## 2026-08-25

### feat(central-rbac): Phase 4-5 complete — Admin UI + deploy (IP-first review mode)

**Status:** ✅ Complete (MVP scope)

Central RBAC portal + backend MVP deployed on authway-vps. Phase 4 delivered Vite + React admin UI (Users + Assignments pages); Phase 5 completed seed data + hardened docker-compose deploy. Live at `http://10.200.0.125:8082/` private IP for anh's review before domain + TLS swap.

**Phase 4 (UI — Users + Assignments):**
- Vite + React + TypeScript + shadcn/ui
- User search + filter (Zitadel API)
- Bulk grant/revoke assignments
- Protected routes + OIDC auth context
- Error boundary + data table component reuse

**Phase 5 (Seed + Deploy):**
- YAML seed for roles + permissions (bootstrap.ts)
- Traefik entrypoint `rbac-review:8082` + authway-prod compose
- Docker build (nginx multi-stage, ~50MB prod image)
- Hardened env vars + secret rotation procedure
- OneMCP wire + Zitadel claim contract v1 (`permissions_hash` + optional inline `permissions[]`)

**Post-review scope (Step 17.5):** Domain + Sectigo TLS cert swap (zero code change — env-based config)

**Files added:**
- `central-rbac-ui/` — Full React admin SPA
- `central-rbac/infra/` — docker-compose, nginx, seed YAML

**Related:**
- Phase 1-3: Commit 612dda9 (Zitadel Action) → a415f2e (Mgmt API)
- Brainstorm: [260825-0957-central-rbac-ip-first-review-mode.md](../plans/reports/brainstorm-260825-0957-central-rbac-ip-first-review-mode.md)
- Plan: [260821-1644-central-rbac-single-pane](../plans/260821-1644-central-rbac-single-pane) phases 4-5

---

## 2026-07-30

### feat(openwebui): session wrap-up hook — auto-classify KB/Report/Research + gatekeeper + template validation

**Status:** ✅ Complete

Plan: `260730-1043-openwebui-wrapup-hook` (Phase 1–4)

OpenWebUI Action button 🏁 "End & Save" — tự động đọc toàn bộ conversation, phân loại thành KB / Report / Research, validate qua gatekeeper, preview cho user xác nhận, rồi submit lên OneMCP.

**New files:**
- `infra/openwebui/actions/wrapup-prompts.py` — classifier + gatekeeper prompt library, 3 template renderers (KB/Report/Research)
- `infra/openwebui/actions/onemcp-wrapup.py` — Action main entry point (1047L), 5 audit events wired

**Components:**
- **Classifier LLM** — đọc conversation, chọn KB/Report/Research dựa trên nội dung; skip nếu session chit-chat / <5 tin nhắn kỹ thuật
- **Gatekeeper LLM** — validate draft đạt quality bar trước khi show preview; reject nếu thiếu nội dung
- **3 template types**: KB (fix/howto), Report (task/incident tổng kết), Research (brainstorm/khảo sát)
- **Preview + confirm flow** — user thấy draft trước khi submit (khác 📚 one-click)
- **5 audit events**: `wrapup.attempted`, `wrapup.skipped_classifier`, `wrapup.rejected_gatekeeper`, `wrapup.cancelled`, `wrapup.submitted`

**OneMCP dependency:**
- Phase 1: report + research templates V2 schemas — commit cf2dc5a (OneMCP repo)

**Tests:** 5/5 pass (`test_wrapup_prompts.py`, 270L)

---

## 2026-07-17

### feat(kb): Pivot to OpenWebUI native + /web removal

**Status:** ✅ Complete

KB workflow pivoted to OpenWebUI native (sidebar Notes + Workspace → Knowledge). Decommissioned custom Next.js KB service, Postgres, and all supporting infrastructure.

**Deleted:**
- `web/` folder (entire Next.js application)
- `infra/openwebui/functions/kb_mark_resolved.py` (OpenWebUI Action Function)
- `docs/deployment-kb.md` (KB service deployment doc)

**Infrastructure removal:**
- Postgres service + docker-compose profile removed
- `web:3000` service removed from compose
- Caddy `/kb/*` proxy routes removed

**Environment variables removed:**
- `KB_WEB_PUBLIC_URL`, `INTERNAL_CRON_TOKEN`
- `OPENWEBUI_ADMIN_API_KEY`, `KB_SUMMARIZE_MODEL`, `KB_LLM_MOCK`
- `KB_QDRANT_COLLECTION`, `KB_DEDUP_THRESHOLD`, `KB_SNAP_THRESHOLD`, `KB_DRAFT_TTL_MINUTES`, `KB_RATE_LIMIT_PER_USER_DAY`
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_IMAGE_TAG`

**Code changes:**
- Removed `_persist_audit()` + `_WEB_URL` ref from `agent/src/agent/routes/alert.py` (replaced with structured log)

**Rationale:** Unify KB workflow inside OpenWebUI — members use native "Add to Note" → sidebar Notes; admin curates + uploads to shared Workspace Knowledge collection. YAGNI custom review UI. No data lost (Phase 1 never deployed to production).

---

## 2026-07-16

### feat(kb): Phase 1 shipped — OpenWebUI integration

**Status:** ✅ Complete

OpenWebUI-based KB Phase 1 deployed. Members can mark resolved chat conversations for KB entry creation via OpenWebUI Function button, then review and edit AI-generated drafts before committing to the vector DB.

**Design pivot:** Original plan (2026-07-16 intra-day attempt) used custom Next.js KB UI. Pivoted to OpenWebUI integration to reduce UI fragmentation — OpenWebUI is already the primary chat interface.
- Original Phase 1: commits 7b20851 (implementation) → c8c843b (revert due to design complexity)
- Pivot Phase 1: commit 30f6ff8 (OpenWebUI Action Function + lightweight web API)

**Components:**
- **OpenWebUI Function** (`infra/openwebui/functions/kb_mark_resolved.py`) — "Mark Resolved" button in message toolbar
- **Web API** (`web/src/app/api/kb/*`)
  - `POST /api/kb/summarize` — fetch chat, LLM draft, taxonomy snap, store draft (30-min TTL)
  - `POST /api/kb/entries` — redact, embed, deduplicate, insert + Qdrant upsert, cleanup draft
  - `POST /api/kb/internal/cleanup-drafts` — expired draft cleanup (cron-triggered)
  - `GET /kb/create` — server-render review form
- **Schema:** kb_entries, kb_drafts, kb_taxonomy, kb_edits
- **Docker:** `web:` service uncommented in compose; wired to profiles `[web, kb]`

**Auth:** OpenWebUI JWT pass-through (summarize), draft access token (entries/review).

**Features:**
- Rate limiting: 20 summarize+entry per user per day (configurable)
- PII redaction: 6 regex patterns (email, priv-IP, JWT, AKIA, Bearer, password)
- Dedup: semantic similarity check (0.85 threshold, configurable)
- Taxonomy: auto-snap topic + issue_type; usage tracking
- Draft review: server-rendered form, optional member edits before commit

**Breaking changes:** None (new feature, no prior API contracts).

**Known issues (Phase 2 follow-ups):**
- M1: Token comparison not constant-time (low attack surface)
- M2: Draft access token in URL query string (mitigate: nginx log filter + `<meta name="referrer">`)
- M3: Rate-limit race window (eventual burst by 1–2 acceptable per spec)
- M4: Cleanup cron not yet scheduled (skeleton route defined; external trigger needed)
- M5: `openwebui_chat_id` nullable (clarify design intent for Phase 2 manual entry feature)

**Test coverage:** Code reviewed (8.5/10), integration tested, prod-ready with minor mitigations.

**Deployment:** See [deployment-guide.md](deployment-guide.md) → "KB Phase 1 env vars" section.

---

## Roadmap entries

See [development-roadmap.md](development-roadmap.md) for phase statuses and next milestones.
