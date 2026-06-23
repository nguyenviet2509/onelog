/**
 * GET /api/admin/audit — paginated audit log.
 *
 * Query params:
 *   source: optional filter (web_chat | alert | mcp)
 *   limit:  default 50, max 200
 *   before: cursor (ISO timestamp) for keyset pagination
 *
 * Keyset pagination over `created_at DESC` keeps deep pages cheap and avoids
 * the `OFFSET` cliff. Admin scope is open while auth is stubbed — gated by
 * Caddy IP allow list at the perimeter.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { ensureBootstrap } from "@/db/bootstrap";
import { getDb, schema } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await ensureBootstrap();
  const db = getDb();
  const sp = req.nextUrl.searchParams;
  const source = sp.get("source");
  const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 50));
  const before = sp.get("before");

  const conditions = [];
  if (source) conditions.push(eq(schema.auditLog.source, source));
  if (before) {
    const cursor = new Date(before);
    if (!Number.isNaN(cursor.getTime())) conditions.push(lt(schema.auditLog.createdAt, cursor));
  }

  const rows = await db
    .select({
      id: schema.auditLog.id,
      userId: schema.auditLog.userId,
      source: schema.auditLog.source,
      conversationId: schema.auditLog.conversationId,
      prompt: schema.auditLog.prompt,
      toolCalls: schema.auditLog.toolCalls,
      latencyMs: schema.auditLog.latencyMs,
      status: schema.auditLog.status,
      createdAt: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(limit);

  const nextCursor = rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null;
  return NextResponse.json({ rows, nextCursor });
}
