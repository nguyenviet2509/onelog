/**
 * POST /api/kb/summarize
 *
 * Input:  { conversationId: string }
 * Output: DraftEntry + snapInfo (taxonomy snap results)
 *
 * Reads conversation messages from Postgres, extracts tool_call evidence,
 * calls LLM to produce a structured draft, then runs taxonomy snap on
 * topic and issue_type. Does NOT write to DB — member reviews draft first.
 *
 * Auth: getCurrentUser() — same stub as other routes.
 */

import { and, asc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ensureBootstrap } from "@/db/bootstrap";
import { getDb, schema } from "@/db/client";
import { getCurrentUser } from "@/lib/auth-stub";
import { summarizeConversation, type DraftEntry } from "@/lib/kb/summarizer";
import { snapTaxonomy, type SnapResult } from "@/lib/kb/taxonomy-snap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Re-export so UI can import DraftEntry from the route module without reaching
// into lib internals.
export type { DraftEntry };

const BodySchema = z.object({
  conversationId: z.string().uuid("conversationId must be a valid UUID"),
});

// SummarizeResponse.draft is exactly DraftEntry — single source of truth from zod schema.
export interface SummarizeResponse {
  draft: DraftEntry;
  snapInfo: {
    topic?: SnapResult;
    issue_type?: SnapResult;
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  await ensureBootstrap();
  const user = getCurrentUser();
  const db = getDb();

  // --- Input validation ---
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
  const { conversationId } = parsed.data;

  // --- Verify conversation ownership (C3: must own conversation to summarize it) ---
  const [conv] = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.userId, user.id),
      ),
    )
    .limit(1);

  if (!conv) {
    // Return 403 — do NOT leak whether the conversation exists at all
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // --- Load messages ---
  const rows = await db
    .select({
      role: schema.messages.role,
      content: schema.messages.content,
      parts: schema.messages.parts,
    })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.createdAt));

  if (rows.length < 2) {
    return NextResponse.json(
      { error: "Conversation has too few messages to summarize" },
      { status: 422 },
    );
  }

  // --- Summarize ---
  let draft;
  try {
    draft = await summarizeConversation(rows);
  } catch (err) {
    console.error("kb.summarize.failed", { conversationId, userId: user.id, err });
    return NextResponse.json(
      { error: `Summarization failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  // --- Taxonomy snap on topic + issue_type ---
  const snapInfo: SummarizeResponse["snapInfo"] = {};

  if (draft.topic) {
    try {
      snapInfo.topic = await snapTaxonomy("topic", draft.topic);
      draft = { ...draft, topic: snapInfo.topic.value };
    } catch (err) {
      console.warn("kb.summarize.snap_topic_failed", err);
    }
  }

  if (draft.issue_type) {
    try {
      snapInfo.issue_type = await snapTaxonomy("issue_type", draft.issue_type);
      draft = { ...draft, issue_type: snapInfo.issue_type.value };
    } catch (err) {
      console.warn("kb.summarize.snap_issue_type_failed", err);
    }
  }

  return NextResponse.json({ draft, snapInfo } satisfies SummarizeResponse);
}
