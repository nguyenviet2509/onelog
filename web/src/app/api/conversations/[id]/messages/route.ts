/**
 * GET /api/conversations/[id]/messages
 * Returns ordered message history for restoring chat UI on reload / open.
 */
import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { ensureBootstrap } from "@/db/bootstrap";
import { getDb, schema } from "@/db/client";
import { getCurrentUser } from "@/lib/auth-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  await ensureBootstrap();
  const user = getCurrentUser();
  const db = getDb();

  // Verify the conversation belongs to the current user (cheap auth boundary
  // while we're still on stub auth — keeps URL probing from leaking other users).
  const [conv] = await db
    .select({ id: schema.conversations.id, title: schema.conversations.title })
    .from(schema.conversations)
    .where(
      and(eq(schema.conversations.id, params.id), eq(schema.conversations.userId, user.id)),
    )
    .limit(1);
  if (!conv) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const rows = await db
    .select({
      id: schema.messages.id,
      role: schema.messages.role,
      content: schema.messages.content,
      parts: schema.messages.parts,
      createdAt: schema.messages.createdAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, params.id))
    .orderBy(asc(schema.messages.createdAt));

  return NextResponse.json({ conversation: conv, messages: rows });
}
