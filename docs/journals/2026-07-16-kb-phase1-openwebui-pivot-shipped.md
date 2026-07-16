# KB Phase 1 Pivot: Custom Web → OpenWebUI Integration

**Date**: 2026-07-16 15:54  
**Severity**: High (design flaw caught mid-implementation)  
**Component**: Knowledge Base Phase 1, OpenWebUI integration, Postgres kb_drafts schema  
**Status**: Resolved — re-implemented and shipped

## What Happened

At 15:54, after Phase 1 shipped its first complete build (13 new files, 3 modified, code review 8/10), the user asked a deceptively simple question: **"Why not use OpenWebUI?"**

The answer was immediate and damning: I'd built the entire feature around a custom Next.js "Mark Resolved" web UI, assuming the team deployed and actively used it. They don't. The team uses OpenWebUI exclusively. The custom web endpoint was never deployed. Postgres `conversations` table contained ~10 rows—test data only, no production chat history.

Phase 1 design was dead on arrival.

## The Brutal Truth

I made a foundational assumption without verification. I saw `web/` schema in the codebase during initial brainstorm (14:22), saw it defined conversations and users, and mentally placed the feature there. I never checked `docker-compose.yml` depth, never asked "is this actually running in production?" Never verified the team's actual workflow.

The frustrating part: the fix cost me ~1 hour and cost the user 0 in production damage only because we caught it before pushing and before any VPS deployment. If this had shipped and been backfilled, the cost would've been 10x—rollback scripts, Postgres data recovery, user confusion, OpenWebUI Function deployment, the works.

The lesson stings because it's obvious in hindsight: when a plan hinges on "reuse existing X," you verify X is actually live, not just in code.

## Technical Details

### Initial Plan (13:48–14:47)
- Design: custom `/web/kb/mark-resolved` endpoint, POST with `conversationId`, `draftId`, `verified_by`
- Frontend: Next.js form button in custom web UI
- Auth: Postgres user FK + auth-stub validation

### Pivot Brainstorm (15:54)
- User input forced re-evaluation: OpenWebUI is the actual chat interface
- New approach: OpenWebUI Function (`kb_mark_resolved.py`) receives chat message → triggers summarize → returns markdown link
- User clicks → `/kb/create?access_token=xxx` review page in browser
- Auth: OpenWebUI JWT pass-through + short-lived `access_token` for review page

### Implementation Changes

**New table:** `kb_drafts` (stores summarized drafts with TTL)
```sql
openwebui_chat_id BIGINT NOT NULL UNIQUE,
summary TEXT NOT NULL,
verified_by TEXT[] DEFAULT '{}',
access_token VARCHAR(128) UNIQUE,
created_at TIMESTAMPTZ DEFAULT now(),
expires_at TIMESTAMPTZ DEFAULT now() + interval '24 hours'
```

**Reused from reverted commit (git show 7b20851):**
- `lib/redact.ts` — PII redaction
- `lib/embed.ts` — embeddings client
- `lib/qdrant.ts` — vector search
- `lib/dedup.ts` — semantic dedup
- `lib/summarizer.ts` — main summarize logic
- `lib/taxonomy-snap.ts` — intent classification
- `lib/summarizer-prompt.ts` (adapted) — only OpenWebUI message format, no Anthropic tool_call blocks

**New files:**
- `lib/openwebui-client.ts` — `/api/v1/auths` + chat validation
- `lib/draft-store.ts` — kb_drafts CRUD + cleanup
- `api/kb/summarize/route.ts` — rewritten for OpenWebUI message format
- `api/kb/mark-resolved/route.ts` — Postgres write, verify + commit
- `api/kb/cleanup/route.ts` — cron endpoint for TTL cleanup
- `kb/create/page.tsx` — review + commit UI
- `kb_mark_resolved.py` — OpenWebUI Function (markdown link generator)

### Architecture Pivot

**Before (custom web):**
```
Chat (OpenWebUI) → message log → ???
                   (no integration)
Custom web (parallel) → custom form → kb_drafts → Postgres
```

**After (OpenWebUI native):**
```
Chat (OpenWebUI)
  ↓
/send message with kb_mark_resolved function
  ↓ (Function executes)
API /summarize → kb_drafts + Qdrant
  ↓
Returns markdown link → Chat message
  ↓
User clicks → /kb/create?access_token=xxx
  ↓
Review + verify_by[] → /mark-resolved → kb_mark_resolved
```

## What We Tried

1. **Assumption-heavy brainstorm** (13:48–14:38): Built entire plan on custom web integration without verification.
2. **Full implementation** (14:47): Phase 1 shipped, code review flagged 7 issues (C1-C3, M2-M5), all fixed.
3. **Commit 7b20851**: Merged custom-web approach.
4. **User question** (15:54): "Why not OpenWebUI?" — singular question that unmade the entire design.
5. **Immediate revert** (c8c843b): Backed out 7b20851 cleanly. Cost was low because no CI/CD push, no VPS deploy.
6. **Pivot brainstorm + re-implementation**: New OpenWebUI-native design documented + re-implemented.
7. **Build + code review (second pass)**: 8.5/10, 5 major issues fixed.

## Root Cause Analysis

**Primary:** I didn't verify production usage patterns before designing. I saw code and assumed it was live.

**Secondary:** Initial brainstorm (14:22 report) lacked a "validate assumptions" step. The plan should've flagged "verify custom web is deployed and in active use."

**Contributing factor:** Revert was cheap because Phase 1 never reached CI/CD or prod. Had we pushed or deployed, cost would've been exponential—recovery scripts, backfill runs, user comms, OpenWebUI Function approval delay.

## Lessons Learned

1. **Assumption audit before implementation**: When a design hinges on "reuse X" or "integrate with Y," explicitly verify:
   - Is Y deployed to production?
   - Is Y actively used by the team?
   - Is Y's API stable and documented?
   
2. **Scout docker-compose.yml and .env carefully**: Don't skim. The source of truth is deployment config, not source code.

3. **Revert is your friend**: Commit early, revert fearlessly before pushing. Low cost saves 10x later.

4. **Access token over JWT for short-lived flows**: JWT can expire between steps (summarize → review click). Access token is stateful, short-lived, revocable on entry commit. Trade-off: URL leak surface, mitigated via `referrer=no-referrer` + `history.replaceState` strip on mount.

5. **Postgres first, Qdrant rollback**: If embedding fails, user still gets Postgres summary. If Qdrant fails, dedup is best-effort. Ordering matters for user experience.

6. **Rate-limit fail-open with logging**: 20/user/day non-atomic ±1-2 overshoot is acceptable for MVP. KISS over distributed locks.

7. **NULL ≠ UNIQUE constraint footgun**: Schema reviewer caught `openwebui_chat_id` initially nullable. In Postgres, NULL is not equal to NULL—multiple NULLs bypass UNIQUE. Fixed: `NOT NULL UNIQUE`.

## Technical Decisions

| Decision | Rationale | Trade-off |
|----------|-----------|-----------|
| OpenWebUI Function → API → kb_drafts | Native chat UX, async summarize, offline review | Access token URL leak, needs cleanup cron |
| Access token (not JWT) for review page | Stateful, short-lived, revocable | URL leak surface, but acceptable + mitigated |
| Postgres-first + Qdrant rollback | User always gets summary, vector search is best-effort | Slightly slower summary path if Qdrant fails |
| Opportunistic cleanup inside summarize + cron endpoint | Belt + suspenders for TTL expiry | Minor Postgres churn, external cron still needed |
| Rate-limit non-atomic with log.warn | KISS, acceptable ±1-2 overshoot for 20/user/day | Not perfectly distributed |

## Next Steps

1. **Pin OpenWebUI image tag** in production before deploying Phase 1. `/api/v1/auths` endpoint may change versions.
2. **Deploy cleanup cron** before backfilling conversations (Phase 1.5). TTL cleanup must run or kb_drafts bloats.
3. **Phase 2:** User ID dedup on `verified_by[]` (currently single-user approvals). Backfill script + dotenv handling.
4. **Monitor:** Rate-limit overshoot, access token URL leaks (referrer logs), Qdrant embedding latency.

## Related Files & Reports

- **Plan:** `plans/260716-1422-chat-conversations-kb-search/plan.md`
- **Initial brainstorm (14:22):** `plans/260716-1422-chat-conversations-kb-search/reports/scout-report.md`
- **Pivot brainstorm (15:54):** `plans/260716-1422-chat-conversations-kb-search/reports/brainstorm-260716-1554-kb-openwebui-pivot.md`
- **Code review (second pass):** `plans/260716-1422-chat-conversations-kb-search/reports/code-review-260716-16xx.md`

**Key implementation files:**
- `lib/openwebui-client.ts` — OpenWebUI integration
- `lib/draft-store.ts` — kb_drafts storage
- `lib/summarizer-prompt.ts` — OpenWebUI message format handling
- `api/kb/summarize/route.ts` — summarize endpoint
- `kb/create/page.tsx` — review + verify page
- `kb_mark_resolved.py` — OpenWebUI Function
- `schema.ts` — kb_drafts table definition

**Commits:**
- `7b20851` — Initial Phase 1 (reverted)
- `c8c843b` — Revert to pre-pivot
- `30f6ff8` — Pivot plan committed
- (Phase 1 re-implementation in progress; will push after final test pass)

---

**Status:** DONE  
**File:** D:\Vietnt\Project\onelog\docs\journals\2026-07-16-kb-phase1-openwebui-pivot-shipped.md
