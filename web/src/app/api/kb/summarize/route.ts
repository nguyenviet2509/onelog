/**
 * POST /api/kb/summarize
 *
 * Input headers: Authorization: Bearer <openwebui_jwt>
 * Input body:    { chatId: string }
 * Output:        { draftId: string, reviewUrl: string }
 *
 * Flow:
 *   1. Validate input
 *   2. Rate limit check (kb_drafts + kb_entries count for user today)
 *   3. verifyOwnership(chatId, jwt) via OpenWebUI API — 403 if fail
 *   4. fetchChatMessages(chatId, jwt)
 *   5. LLM summarize → DraftEntry
 *   6. Taxonomy snap topic + issue_type
 *   7. createDraft() → returns draftId + accessToken
 *   8. Return { draftId, reviewUrl }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";

import { ensureBootstrap } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { verifyOwnership, fetchChatMessages, getCurrentUser } from "@/lib/kb/openwebui-client";
import { summarizeConversation } from "@/lib/kb/summarizer";
import { snapTaxonomy } from "@/lib/kb/taxonomy-snap";
import { createDraft, cleanupExpiredDrafts } from "@/lib/kb/draft-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const BodySchema = z.object({
  chatId: z.string().min(1).max(128),
});

// ---------------------------------------------------------------------------
// Rate limit check
// ---------------------------------------------------------------------------

const RATE_LIMIT = parseInt(process.env.KB_RATE_LIMIT_PER_USER_DAY ?? "20", 10);

/**
 * Count drafts + committed entries created by this user in the last 24h.
 * Returns true if the user has hit the daily cap.
 */
async function isRateLimited(userId: string): Promise<boolean> {
  const db = getDb();

  // Count kb_entries created by user in last 24h
  const entriesResult = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM kb_entries
        WHERE created_by = ${userId}
          AND created_at > NOW() - INTERVAL '1 day'`,
  );

  // Count kb_drafts created by user in last 24h (pending, not yet committed)
  const draftsResult = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM kb_drafts
        WHERE openwebui_user_id = ${userId}
          AND created_at > NOW() - INTERVAL '1 day'`,
  );

  const entriesCount = parseInt(entriesResult[0]?.count ?? "0", 10);
  const draftsCount = parseInt(draftsResult[0]?.count ?? "0", 10);

  return entriesCount + draftsCount >= RATE_LIMIT;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  await ensureBootstrap();

  // --- Auth header ---
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }
  const jwt = authHeader; // keep "Bearer <token>" prefix for pass-through

  // --- Parse + validate body ---
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { chatId } = parsed.data;

  // --- Identify user via OpenWebUI JWT ---
  let userId: string;
  try {
    const user = await getCurrentUser(jwt);
    if (!user) {
      return NextResponse.json({ error: "Invalid or expired JWT" }, { status: 401 });
    }
    userId = user.id;
  } catch (err) {
    console.error("kb.summarize.getCurrentUser_failed", err);
    return NextResponse.json({ error: "Auth service unavailable" }, { status: 502 });
  }

  // --- Rate limit ---
  // Note: rate-limit COUNT check is non-atomic — 2 concurrent requests may both
  // pass at count=N-1. Accepted overshoot ≤ concurrent_req_count for 20/user/day
  // limit (KISS over lock). Use SELECT FOR UPDATE if strict cap is ever required.
  try {
    if (await isRateLimited(userId)) {
      return NextResponse.json(
        { error: `Rate limit: max ${RATE_LIMIT} KB entries/day` },
        { status: 429 },
      );
    }
  } catch (err) {
    // Rate limit check failure: fail open (allow) but log warning.
    // Under DB flap a user may exceed daily cap — acceptable trade-off vs
    // blocking all summarize requests when DB is degraded.
    console.warn("kb.summarize.rate_limit_check_failed — failing open", err);
  }

  // --- Verify ownership ---
  let chatData;
  try {
    const ownership = await verifyOwnership(chatId, jwt);
    if (!ownership.ok) {
      return NextResponse.json({ error: "Forbidden — not chat owner" }, { status: 403 });
    }
    chatData = ownership.chatData;
  } catch (err) {
    console.error("kb.summarize.verifyOwnership_failed", err);
    return NextResponse.json({ error: "OpenWebUI unreachable" }, { status: 502 });
  }

  // --- Fetch messages (reuse chatData from ownership check to avoid double call) ---
  let messages;
  try {
    messages = await fetchChatMessages(chatId, jwt, chatData);
  } catch (err) {
    console.error("kb.summarize.fetchMessages_failed", err);
    return NextResponse.json({ error: "Failed to fetch chat messages" }, { status: 502 });
  }

  if (messages.length === 0) {
    return NextResponse.json({ error: "Chat has no messages" }, { status: 422 });
  }

  // --- LLM summarize ---
  let draft;
  try {
    draft = await summarizeConversation(messages);
  } catch (err) {
    console.error("kb.summarize.llm_failed", err);
    return NextResponse.json({ error: "Summarization failed" }, { status: 502 });
  }

  // --- Taxonomy snap topic + issue_type ---
  try {
    if (draft.topic) {
      const snap = await snapTaxonomy("topic", draft.topic);
      draft = { ...draft, topic: snap.value };
    }
    if (draft.issue_type) {
      const snap = await snapTaxonomy("issue_type", draft.issue_type);
      draft = { ...draft, issue_type: snap.value };
    }
  } catch (err) {
    // Snap failure is non-fatal — proceed with raw LLM values
    console.warn("kb.summarize.taxonomy_snap_failed", err);
  }

  // --- Create draft record ---
  let draftId: string;
  let accessToken: string;
  try {
    ({ draftId, accessToken } = await createDraft(chatId, userId, draft));
  } catch (err) {
    console.error("kb.summarize.create_draft_failed", err);
    return NextResponse.json({ error: "Failed to save draft" }, { status: 500 });
  }

  const baseUrl = (process.env.KB_WEB_PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const reviewUrl = `${baseUrl}/kb/create?draft=${draftId}&token=${accessToken}`;

  // M4: Opportunistic cleanup — fire-and-forget expired draft GC so the table
  // stays trim even without an external cron scheduler. Errors are logged but
  // never surface to the caller.
  cleanupExpiredDrafts().catch((e) =>
    console.warn("kb.summarize.opportunistic_cleanup_failed", e),
  );

  return NextResponse.json({ draftId, reviewUrl }, { status: 200 });
}
