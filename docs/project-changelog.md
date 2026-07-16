# Project Changelog

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
