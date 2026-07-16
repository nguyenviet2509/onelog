# Code Review — Phase 1 KB Creation

**Reviewer:** code-reviewer | **Date:** 2026-07-16 | **Scope:** Additive files listed in prompt
**Build:** Passing (TS strict, Next.js 14)

## Scores

| Dimension | Score | Notes |
|---|---|---|
| Correctness | 7/10 | Solid flows; a few concurrency + ordering bugs (see Critical) |
| Security | 8/10 | Redact + zod good; auth stub reused OK; minor gaps |
| KISS/DRY | 9/10 | Clean, no over-engineering, files under 200 lines |
| UX | 8/10 | Modal state machine complete; loading/error handled |
| **Overall** | **8/10** | |

## Critical Issues (must fix before merge)

### C1. Taxonomy `usage_count` double-increment on entry create
`summarize/route.ts:113,122` calls `snapTaxonomy()` which increments `usage_count` on match. Then `entries/route.ts:215-219` `bumpTaxonomy()` increments the SAME row again on commit. Result: every entry create bumps count by 2 for topic/issue_type (department only bumps once since dept goes through `bumpTaxonomy` only).

Also violates the plan spec: *"`usage_count` incremented only on successful commit (not on draft/summarize)"*. Snap during summarize is a draft step — user may abandon → phantom increment.

**Fix:** Remove the `incrementUsage` side-effect from `snapTaxonomy` (make it pure normalize + insert-if-new-with-count=0). Increment only from `entries/route.ts` after commit. Or insert with `usageCount: 0` in snap step and let `bumpTaxonomy` do the +1 always.

Currently new-value insert uses `usageCount: 1` (`taxonomy-snap.ts:140`) even at summarize time — same phantom-count problem.

### C2. Qdrant/Postgres rollback ordering contradicts plan
Plan §Implementation Steps 8 says: *"Qdrant upsert first (idempotent) … Postgres insert second; if Postgres fails → delete Qdrant point"*.

`entries/route.ts:159-206` does the OPPOSITE: Postgres insert first, then Qdrant upsert, rollback Postgres on Qdrant fail. This choice is defensible (avoids orphaned vectors on Postgres FK failures) but:

- The header comment at lines 12-14 misdescribes it: says "Qdrant upsert first (idempotent)" but code does Postgres first.
- Real risk: Postgres row committed BEFORE Qdrant returns → if the Node process is killed between insert and upsert, Postgres has a row with `embedding_id=null` and no Qdrant vector → orphan invisible to dedup/search. No reconciler yet (weekly job deferred per prompt).

**Fix:** Reconcile intent vs code. Either flip to Qdrant-first, or acknowledge in comments + add a `WHERE embedding_id IS NULL` sweep to backfill script (cheap safety net).

### C3. `entries/route.ts` no ownership check on `conversationId`
Line 160-177 inserts `kb_entries.conversation_id` from client-supplied body. There is NO check that `entry.conversationId` belongs to the current user. A malicious/authenticated user could attach a KB entry to another user's private conversation UUID (if guessable) or to a nonexistent UUID (FK will catch nonexistent, but not cross-user).

`summarize/route.ts:68-76` checks conversation exists but also does NOT verify `userId = user.id` — differs from `page.tsx:20-23` which does check ownership.

**Fix:** Both routes should `WHERE conversations.id = ? AND conversations.user_id = user.id` — reject 404 if not owned.

## Major Issues (should fix)

### M1. `snapTaxonomy` N+1 embed calls
`taxonomy-snap.ts:120-124`: for every existing value, call `embedText(v)` in a loop. With 50 topics, that's 50 sequential embed API calls per snap = ~2-10s latency + $$$ per summarize call. Compounds because summarize runs snap twice (topic + issue_type).

**Fix (minor effort):** Batch — one call with `input: [proposal, ...existing]` (OpenAI supports batch). Or (KISS) cache embeddings for existing taxonomy values in-memory / in `kb_taxonomy.embedding` column. Or skip embed-similarity when >20 candidates and rely on Levenshtein.

### M2. `snapTaxonomy` race on new-value insert
Between line 87 (SELECT existing) and line 138 (INSERT ON CONFLICT DO NOTHING): two concurrent requests can both miss on both Lev + embed → both attempt insert. `ON CONFLICT DO NOTHING` handles PK collision but the loser silently returns `{value: proposal, snapped: false}` with usage_count still 0 and no bump. Minor — the winner's insert has count=1, but if C1 fix moves count to entries route only, this becomes fine.

### M3. `SummarizeResponse` mutates `draft` after zod parse
`summarize/route.ts:114,123`: `draft = { ...draft, topic: snapInfo.topic.value }`. Fine, but the `SummarizeResponse.draft` interface (line 32-41) duplicates `DraftEntry` fields loosely (`department?: string` vs `z.enum(...)`). Drift risk when schema changes. Also `tags: string[]` is not `.default([])` on the wire — `draft.tags` from LLM already defaulted by zod, but re-declaring the interface loses that guarantee.

**Fix:** `export type SummarizeResponse = { draft: DraftEntry; snapInfo: {...} }`.

### M4. Bootstrap DDL — missing FK cascade + no unique on `(conversation_id)` in kb_entries
`kb_entries.conversation_id` references `conversations(id)` without `ON DELETE`. If a conversation is deleted, the FK will BLOCK the delete (default RESTRICT). This is likely NOT intended — deleting the source conversation should either cascade or set null. Also, no uniqueness on `conversation_id` — a user can create multiple entries from the same conversation (probably intended; document this if so). Backfill script's dedup check on `conversationId` (line 86) assumes at most one entry per conv, but nothing enforces it.

### M5. Modal — "Edit Draft" button preserves stale `dedupHits` state
`mark-resolved-modal.tsx:258`: setStep("review") clears dedupHits but if the user re-submits without changing anything, they'll hit dedup 409 again with no way to know the previous hits were the same → confusing. Minor UX.

Also `submitEntry(true)` after force → still calls dedup path (checkDuplicates is skipped server-side on `force`, good). But the modal never shows "similar entries you might upvote" as an alternative to force — the plan mentions "Merge / Upvote existing #123 / Force create" but UI only has Force + Cancel + Edit. Upvote path deferred? Acknowledge in phase-02 doc.

## Minor Issues (nice to have)

### m1. `redact.ts` regex parity — bearer + password
Python uses `(?i)` inline flag; TS uses `/gi`. Behavior equivalent. However Python `password` pattern trailing char class is `[^\s,;\"]+` (excludes `"` but NOT `'`), TS is `[^\s,;"']+` (excludes both). Small drift, TS is stricter — probably fine but note.

Also Python email regex has no `\b` boundary; TS same. Consistent.

### m2. `embed-client.ts` — no timeout on fetch
Long-hanging fetch to OpenAI can stall the Next request indefinitely. Add `AbortSignal.timeout(15_000)` for embed + summarize + qdrant fetches.

### m3. `qdrant-client.ts:48-55` — swallows non-404 errors
`ensureCollection` catches ALL errors from GET → tries PUT. If GET fails due to auth (401) or network, PUT will also fail but with less useful error. Consider only creating on explicit 404 from response.

### m4. `qdrant-client.ts` — `uuidToQdrantId` is identity, misleading
Function does nothing. Delete it and pass `id` directly, or add a comment "reserved for future non-UUID ids".

### m5. `summarizer-prompt.ts:62-66` — user role fallthrough logic
When `msg.role === "user"` and `parts` is null, includes user content as evidence. Comment says "User messages are excluded — they introduce noise and PII risk" (lines 51-52) — contradicts the code. Pick one.

### m6. `entries/route.ts` — `tags` array size (`.max(20)`) not enforced on backfill
Backfill (`kb-backfill.ts:154`) does not truncate/cap tags. If LLM returns >20 tags, backfill inserts them; API route rejects. Inconsistent.

### m7. `mark-resolved-modal.tsx:76` — tags rendering assumes `d.tags` is array
Zod `.default([])` on server. If SummarizeResponse interface drifts (M3), could crash. Cheap `??[]` fallback in place — OK.

### m8. `entries/route.ts:209-212` — needless UPDATE
After Postgres insert with `embedding_id: null`, then UPDATE to set `embedding_id = entryId`. Why not just include it in the initial INSERT after computing the id (or use `entryId = crypto.randomUUID()` client-side)? Cuts one round-trip.

### m9. `bootstrap.ts` — race on first request
`ensureBootstrap` uses module-level `_done` flag but two concurrent requests both hitting cold module → both try `sql.unsafe(DDL)`. `IF NOT EXISTS` protects tables, but `INSERT ... ON CONFLICT DO NOTHING` also idempotent — actually safe. Fine.

### m10. `.env.example` — no `AGENT_URL` default nor `KB_LLM_MOCK=true` default for local dev
Small onboarding friction. Consider `KB_LLM_MOCK=true` as default in example to make first-run work without API keys.

### m11. `summarizer.ts:143` — retry hides original error
`console.warn` logs firstErr but the second attempt's error is thrown without the first as `cause`. If both are the same class of failure, debugging is harder. Use `new Error(msg, { cause: firstErr })`.

### m12. `mark-resolved-modal.tsx` — no CSRF/auth token
Fetches are same-origin with cookies (Next.js default) → fine. No explicit CSRF header, but Next.js App Router doesn't ship CSRF by default. Auth stub means anyone can hit these routes. Document this is MVP.

## Praise

- **Redact port**: 6 patterns match Python exactly; RegExp `lastIndex` reset comment shows awareness of the /g stateful gotcha. Good.
- **Mock modes**: both `KB_LLM_MOCK` and no-API-key paths return deterministic outputs — CI-friendly. Mock vector algorithm mirrors Python byte-for-byte.
- **File sizes**: all under 200 lines, well-decomposed (summarizer + summarizer-prompt split). KISS.
- **Zod at boundaries**: both API routes validate before touching DB.
- **`checkDuplicates` fail-open**: unreachable Qdrant during dedup does NOT block insert — sensible for MVP.
- **Modal state machine**: clean discriminated `Step` type; loading + error branches present.
- **Auth-stub reuse**: consistent with existing pattern rather than inventing new auth.
- **Bootstrap DDL**: idempotent, indexes on `(department, topic, issue_type)` + `(conversation_id)` future-proof for Phase 2 browse.
- **Backfill script**: rate-limited, dry-run flag, existing-entry filter — production-safe.
- **Client island**: MarkResolvedButton correctly isolated as `"use client"` while page.tsx stays a server component.

## Decision

**APPROVED_WITH_MINOR** — C1 (double-increment) and C3 (ownership check) are blocking. C2 needs a comment fix at minimum. Everything else can ship as follow-ups.

## Unresolved Questions

- Should `conversation_id` in `kb_entries` be unique? Backfill assumes so but schema doesn't enforce.
- Is the "Upvote existing" flow deferred to Phase 2? Plan mentions it but modal only has Force/Cancel.
- Qdrant-first vs Postgres-first for atomic insert — which does the team prefer? Comment mismatch needs resolution.
- `KB_LLM_MOCK` semantics: when `DEEPSEEK_API_KEY` is set but `OPENAI_API_KEY` is not, summarizer runs real but embed runs mock — is this intended? Currently possible.

---

**Status:** DONE_WITH_CONCERNS
**Score:** 8/10
**Decision:** APPROVED_WITH_MINOR
