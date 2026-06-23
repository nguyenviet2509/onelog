/**
 * GET  /api/conversations         → list current user's conversations (newest first)
 * POST /api/conversations         → create empty conversation, return id
 */
import { desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { ensureBootstrap } from "@/db/bootstrap";
import { getDb, schema } from "@/db/client";
import { getCurrentUser } from "@/lib/auth-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureBootstrap();
  const user = getCurrentUser();
  const db = getDb();
  const rows = await db
    .select({
      id: schema.conversations.id,
      title: schema.conversations.title,
      updatedAt: schema.conversations.updatedAt,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.userId, user.id))
    .orderBy(desc(schema.conversations.updatedAt))
    .limit(100);
  return NextResponse.json({ conversations: rows });
}

export async function POST(req: NextRequest) {
  await ensureBootstrap();
  const user = getCurrentUser();
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  const db = getDb();
  const [row] = await db
    .insert(schema.conversations)
    .values({ userId: user.id, title: body.title?.slice(0, 200) || "New conversation" })
    .returning({ id: schema.conversations.id });
  return NextResponse.json({ id: row.id });
}
