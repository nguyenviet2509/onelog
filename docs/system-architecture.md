# System Architecture

> OneLog RAG stack with KB Phase 1 (OpenWebUI integration).

## High-level topology

```
┌─────────────────────────────────────────────────────────────┐
│  OpenWebUI (chat UI, 0.6.x+)                                │
│  • User starts chat with LLM                                │
│  • "Mark Resolved" button → kb_mark_resolved.py Function    │
└────────────────┬────────────────────────────────────────────┘
                 │ POST /api/kb/summarize
                 │ Authorization: Bearer <openwebui_jwt>
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  Next.js Web Service (port 3000, profile: web + kb)         │
│  • POST /api/kb/summarize — LLM draft + taxonomy snap       │
│  • POST /api/kb/entries — insert + embed + deduplicate      │
│  • GET /kb/create — server-render review form               │
│  • POST /api/kb/internal/cleanup-drafts — TTL cron          │
│                                                              │
│  Auth: OpenWebUI JWT pass-through + access token (drafts)  │
└────────┬────────────────────────────┬──────────────────────┘
         │                            │
         ▼                            ▼
    [Postgres]                   [Qdrant] (6333)
    kb_entries                   Vector DB
    kb_drafts                    Semantic search
    kb_taxonomy
    kb_edits
```

## KB Phase 1 flow (OpenWebUI pivot)

**Timeline:** 2026-07-16 (shipped same day as intra-day pivot from custom-web attempt)

### 1. Trigger: OpenWebUI Function (kb_mark_resolved.py)

- Loaded via OpenWebUI Admin → Functions → + Add Function
- Action type: button in message toolbar
- **Inputs:** `chat_id`, OpenWebUI JWT (`__user__.token`)
- **Output:** Markdown link to review page

### 2. Summarize (POST /api/kb/summarize)

Request:
```json
{
  "Authorization": "Bearer <openwebui_jwt>",
  "body": { "chatId": "<uuid>" }
}
```

Processing:
- **Rate limit:** KB_RATE_LIMIT_PER_USER_DAY (default: 20) — count of drafts + entries per user per day
- **Verify ownership:** GET `/api/v1/chats/{id}` against OpenWebUI; 403 if not owner
- **Fetch messages:** Load chat history from OpenWebUI
- **LLM draft:** DeepSeek (configurable) or mock — structure: `{ title, symptom, root_cause, fix, department, topic, issue_type, tags }`
- **Taxonomy snap:** INSERT new taxonomy values (`kb_taxonomy`) for `topic` + `issue_type` (idempotent `ON CONFLICT DO NOTHING`)
- **Create draft:** INSERT `kb_drafts` (TTL: KB_DRAFT_TTL_MINUTES, default 30 min) → returns `draftId` + `accessToken` (64-byte hex)

Response:
```json
{
  "draftId": "<uuid>",
  "reviewUrl": "https://kb.example.com/kb/create?draft=<uuid>&token=<hex64>"
}
```

### 3. Review & Edit (GET /kb/create?draft=X&token=Y)

- Server-side fetch: `getDraftByToken(draftId, accessToken)` → render form
- Member edits fields (title, symptom, root_cause, fix, department, topic, issue_type, tags)
- Submit → POST `/api/kb/entries`

### 4. Commit (POST /api/kb/entries)

Request:
```json
{
  "draftId": "<uuid>",
  "accessToken": "<hex64>",
  "edits": { "title": "...", ... },  // optional, overrides draft
  "force": false  // ignore dedup hits if true
}
```

Processing:
- **Fetch draft:** `getDraftByToken(draftId, accessToken)` → 410 if expired
- **Merge:** edits override draft fields
- **Redact:** PII strip (6 patterns: email, priv-IP, JWT, AKIA, Bearer, password)
- **Embed:** call EMBED_MODEL (default: sentence-transformers/all-MiniLM-L6-v2) on title + symptom + root_cause
- **Dedup:** check `checkDuplicates()` in Qdrant (threshold KB_DEDUP_THRESHOLD, default 0.85) → 409 if hits AND !force
- **Insert:** kb_entries (openwebui_chat_id, created_by, embedding, tags, etc.)
- **Qdrant upsert:** POST point with payload (id, embedding, metadata) → rollback kb_entries if fail
- **Taxonomy bump:** increment `usage_count` for topic + issue_type
- **Cleanup draft:** DELETE kb_drafts row
- **Delete KB_DRAFTS entry**

Response on success:
```json
{ "id": "<kb_entry_id>" }
```

Response on dedup (409):
```json
{
  "dedupHits": [
    { "id": "...", "title": "...", "similarity": 0.92 },
    ...
  ]
}
```

### 5. Cleanup cron (POST /api/kb/internal/cleanup-drafts)

- Protected by `x-internal-token: $INTERNAL_CRON_TOKEN`
- DELETE kb_drafts WHERE created_at < NOW() - INTERVAL KB_DRAFT_TTL_MINUTES
- Fire-and-forget inside `/api/kb/summarize` (opportunistic); schedule externally (systemd timer / cron) for periodic runs

## Schema overview

### kb_entries

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| openwebui_chat_id | VARCHAR(64) | NOT NULL, UNIQUE (1 entry per chat) |
| created_by | VARCHAR(64) | OpenWebUI user_id (no FK) |
| title | TEXT | Redacted |
| symptom | TEXT | Redacted |
| root_cause | TEXT | Redacted |
| fix | TEXT | Redacted |
| department | ENUM | SRE, DBA, NetOps, AppDev, Security |
| topic | VARCHAR(64) | Taxonomy ref |
| issue_type | VARCHAR(64) | Taxonomy ref |
| tags | TEXT[] | Array of tags |
| embedding | vector(384) | Qdrant sync |
| created_at | TIMESTAMP | Auto |

### kb_drafts

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| openwebui_user_id | VARCHAR(64) | Non-null |
| draft_json | JSONB | DraftEntry schema |
| access_token | VARCHAR(64) | Hex, constant-time compare |
| created_at | TIMESTAMP | Auto |
| expires_at | TIMESTAMP | NOW() + KB_DRAFT_TTL_MINUTES |

### kb_taxonomy

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| kind | ENUM | topic, issue_type, department |
| value | VARCHAR(64) | |
| usage_count | INT | Bump on entry insert; not bumped on snap |
| created_at | TIMESTAMP | Auto |
| UNIQUE (kind, value) | | |

### kb_edits (audit log)

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| kb_entry_id | UUID | FK |
| edited_by | VARCHAR(64) | OpenWebUI user_id |
| diff | JSONB | { before: {...}, after: {...} } |
| edited_at | TIMESTAMP | Auto |

## Environment variables

See [deployment-guide.md](deployment-guide.md) → "KB Phase 1 env vars" section for the full list.

Key vars:
- `OPENWEBUI_URL`, `OPENWEBUI_ADMIN_API_KEY` — OpenWebUI integration (backfill)
- `KB_DRAFT_TTL_MINUTES` — draft expiry (default: 30)
- `KB_RATE_LIMIT_PER_USER_DAY` — summarize+entry cap (default: 20)
- `KB_WEB_PUBLIC_URL` — for review URL in Function response
- `INTERNAL_CRON_TOKEN` — cleanup auth
- `DEEPSEEK_API_KEY`, `OPENAI_API_KEY` — LLM summarize
- `EMBED_MODEL`, `EMBED_MOCK` — embedding service

## Pivot note (transparency)

**Original design (reverted 2026-07-16):** Custom Next.js web-only KB UI ("Chat Conversations" module). Complexity: schema versioning, new auth layer.

**Current design (Phase 1 shipped):** OpenWebUI integration via Action Function + lightweight web API. Rationale: OpenWebUI is already the primary chat UI; adding KB there reduces UI fragmentation. Web service is thin (API only, no chat replay).

Commits: 7b20851 (original phase-1) → c8c843b (revert) → 30f6ff8 (pivot committed).

## References

- [deployment-guide.md](deployment-guide.md) — KB-specific deployment steps
- [project-changelog.md](project-changelog.md) — 2026-07-16 KB Phase 1 entry
- [development-roadmap.md](development-roadmap.md) — KB phases and milestones
