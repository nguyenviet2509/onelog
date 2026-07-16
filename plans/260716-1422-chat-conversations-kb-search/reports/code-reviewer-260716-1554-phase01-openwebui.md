# Phase 1 OpenWebUI-Pivot — Code Review

Date: 2026-07-16
Reviewer: code-reviewer
Scope: OpenWebUI pivot re-implementation (post-revert of 7b20851)

## Score: 8.5 / 10

Rubric:
- Correctness (fixes preserved, control flow sound): 9/10
- Security (auth, PII, injection, secrets): 7/10 — token compare + query-string leak
- Concurrency/robustness (race, rollback, retries): 8/10 — rate-limit race, no GC cron
- Schema soundness: 8/10 — 1 nullable oddity
- Readability / DRY / KISS: 9/10
- Trust boundary / API contract: 9/10

---

## Critical (BLOCKING)

None. Fixes C1/C2/M2/M3 from prior review preserved.

---

## Major (should fix before prod)

### M1 — Timing-attack-safe token comparison
`web/src/lib/kb/draft-store.ts:92` compares access_token with plain `!==`.
Comment acknowledges "constant-time not strictly needed" but leaves door open to timing side-channel enumeration of valid tokens across many draft IDs.
Cost is negligible; fix:
```ts
import { timingSafeEqual } from "crypto";
const a = Buffer.from(row.accessToken, "hex");
const b = Buffer.from(accessToken, "hex");
if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
```
Guard length first — `timingSafeEqual` throws on length mismatch.

### M2 — Access token exposed in URL query string
`web/src/app/api/kb/summarize/route.ts:189` builds `reviewUrl = ${base}/kb/create?draft=...&token=...`.
Risks:
- Nginx / reverse-proxy access logs record full query string by default.
- Browser history persists the token.
- Any `Referer` header from `/kb/create` page (currently no outbound link — safe *today*, brittle *tomorrow*).

Mitigations (pick one, YAGNI-friendly first):
1. Set `<meta name="referrer" content="no-referrer">` on `/kb/create/page.tsx`.
2. Move token from query to `#fragment` (never sent to server-side proxy/log; still readable by client-side JS, but page is server-rendered so needs client hop).
3. Document nginx log filter: `log_format kb_safe ... 'uri="$uri" args="$args_no_token"';` — least ergonomic.

Minimum acceptable: option 1 + documented nginx risk in deployment doc.

### M3 — Rate-limit race window
`web/src/app/api/kb/summarize/route.ts:51` — two concurrent requests both read count=N < LIMIT and both proceed. User can burst 2× cap. Cheap fix:
```sql
INSERT INTO kb_rate_lock(user_id, day, count)
VALUES (...) ON CONFLICT (user_id,day)
DO UPDATE SET count = kb_rate_lock.count + 1
RETURNING count;
```
Then reject if returned count > LIMIT + rollback. Or accept as documented "eventual over-limit by 1–2" — spec-driven decision. Flag: current code silently overshoots.

### M4 — `cleanupExpiredDrafts` never scheduled
`web/src/lib/kb/draft-store.ts:119` defined, has no HTTP route, no cron, no service in `infra/docker-compose.yml`. `kb_drafts` grows monotonically. TTL is enforced at read-time only.
Fix (KISS): add `web/src/app/api/kb/cleanup/route.ts` protected by internal token + docker-compose cron sidecar (or `pg_cron` extension). Not urgent for MVP but must be tracked.

### M5 — `openwebui_chat_id UNIQUE nullable` — schema mismatch with invariant
`kb_entries.openwebui_chat_id VARCHAR(64) UNIQUE` allows multiple NULLs.
Contract says "1 entry per chat". Backfill + summarize always pass a non-null value → nullable serves no purpose and weakens the invariant. Make `NOT NULL` unless a deliberate use case for `NULL` exists (manually authored KB entry without a chat? — not implemented).

If nullable is intentional (Phase 2 manual authoring), add app-level assertion + comment.

---

## Minor (nice to have)

### N1 — 410 lumps three distinct states
`/api/kb/entries` returns 410 for: not found, expired, token mismatch. Server component `/kb/create` also can't distinguish. UX message says "expired" but token-mismatch victim gets same message. Cheap: `getDraftByToken` return `{ok:false, reason:"not_found"|"expired"|"token_mismatch"}`.

### N2 — Rate-limit runs before ownership verification
User can flood `/api/kb/summarize` with unowned chat IDs and burn quota (own quota, not victim's). Ordering matters if `verifyOwnership` failures should NOT count toward quota. Current code inserts draft only after verify + LLM, so failed ownership does *not* eat quota. But `getCurrentUser` runs first and counts pass-through — fine. No fix needed; confirming.

### N3 — Rate-limit check fail-open silent
`route.ts:123-126` swallows DB error and proceeds. Under DB flaps a user with 100 open drafts could bypass. Fail-open is defensible (usability > strict cap) but should log at `error`, not `warn`, and emit a metric hook.

### N4 — `verified_by TEXT[]` allows duplicate user IDs
Schema-level: no UNIQUE-in-array constraint. App-level: no dedup guard yet (no verify endpoint in Phase 1 — safe for now). Note for Phase 2.

### N5 — Backfill uses admin API key as JWT
`kb-backfill.ts:241` `fetchChatMessages(chat.id, adminKey)`. Assumes OpenWebUI treats `Bearer <admin-key>` identically to a user JWT on `/api/v1/chats/{id}`. Documented as known assumption in spec; verify against OpenWebUI 0.6.x before running on prod dataset.

### N6 — Files over 200-line convention
- `entries/route.ts` = 262 lines
- `kb-draft-form.tsx` = 345 lines
Cohesive; splitting adds indirection. YAGNI — skip.

### N7 — `snapTaxonomy` embed loop is O(N) per-call, per-value
For each existing taxonomy value it calls `embedText(v)` synchronously — hits embedding API N times per snap. Caches: none. For growing taxonomy (>50 values) this stacks up. Cache existing-value embeddings in a module-level Map keyed by `kind:value`, invalidate on insert. Not urgent (taxonomy small in MVP).

### N8 — `bumpTaxonomy` for `department` runs unconditionally
Entries route bumps taxonomy for `department`, but the summarize route only snap-inserts `topic` + `issue_type`. So `department` gets `UPDATE ... WHERE kind='department' AND value=<literal>` and silently no-ops on missing row (OK — best-effort). Optional: seed `department` values in bootstrap DDL for consistent usage counts.

### N9 — `res.text().catch(() => "")` idiom missing on OpenWebUI 5xx
`openwebui-client.ts:82-89` tries `res.json()` then swallows → `data=null`. On 5xx the raw body is discarded before it can be logged. Debugging OpenWebUI outages will be painful. Consider capturing body text on non-2xx.

---

## Praise

- **fix-C1 preserved**: `snapTaxonomy` explicitly documents (line 95) and does not bump `usage_count`. `bumpTaxonomy` in entries route is the single source of increments.
- **fix-C2 preserved**: Postgres INSERT → Qdrant upsert → rollback on qdrant fail (`entries/route.ts:230-239`) with orphan detection log for double-failure. Log messages accurate.
- **Redact 6-regex intact**: email, priv-IP, JWT, AKIA, Bearer, password. Regex resets `lastIndex` explicitly (safe for /g flag re-use).
- **Ownership + fetch de-duplication**: `verifyOwnership` returns `chatData`; `fetchChatMessages` reuses it — 1 HTTP call instead of 2.
- **Draft not deleted on 409 dedup**: caller can retry with `force=true` cleanly. No orphan draft.
- **Function Python covers all documented error codes**: 200/429/403/401/422/5xx/timeout/connection error. Clear user-facing messages.
- **Zod validation on draft_json at read-time** (entries/route.ts:148) — defensive parse even though data written by our own summarize route. Correct paranoia given JSONB round-trip.
- **`onConflictDoNothing` + fallback SELECT** in `snapTaxonomy:141-150` handles the concurrent-insert race for new taxonomy values correctly.
- **Rate-limit inclusive of drafts + entries** — matches spec "20 summarize/user/day".
- **JWT never logged** — only opaque errors surface in console.
- **Server component `/kb/create/page.tsx`** does the DB fetch server-side → token never round-trips to browser JS after initial URL parse.

---

## Approval

**APPROVED_WITH_MINOR**

Rationale: no blocking issues; fix-C1/C2 verified preserved; new attack surface (draft token) is defensible but M1+M2 should land before public rollout to any non-internal user. M3 (rate-limit race) and M4 (GC cron) are cheap follow-ups. M5 (nullable chat_id) is schema hygiene.

---

## Unresolved questions

1. Is `nullable openwebui_chat_id` a deliberate Phase-2 hook (manual KB entry)? If yes, document; if no, tighten to `NOT NULL`.
2. Does OpenWebUI 0.6.x accept admin API key on `/api/v1/chats/{id}` identical to a user JWT (backfill assumption)?
3. Where should `cleanupExpiredDrafts` be triggered — internal cron endpoint + external scheduler, or `pg_cron`? (deployment concern)
4. Rate-limit race: accept "eventual over-limit by 1–2" as design, or is strict cap required? (product decision)

---

**Status:** DONE
**Score:** 8.5/10
**Decision:** APPROVED_WITH_MINOR
