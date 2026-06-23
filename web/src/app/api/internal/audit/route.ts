/**
 * POST /api/internal/audit — internal sink for non-chat audit rows (alerts, MCP, …).
 *
 * Trusted callers on the docker network (e.g. agent) post a single row that
 * mirrors the `audit_log` shape. No auth: gated by network segmentation +
 * Caddy not exposing this path externally.
 */
import { NextRequest, NextResponse } from "next/server";

import { ensureBootstrap } from "@/db/bootstrap";
import { getDb, schema } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  source: string;
  userId?: number;
  conversationId?: string | null;
  prompt: string;
  toolCalls?: { name: string; input: unknown; ok: boolean }[];
  latencyMs?: number;
  status?: "ok" | "error";
};

export async function POST(req: NextRequest) {
  await ensureBootstrap();
  const db = getDb();
  const b = (await req.json()) as Body;
  if (!b?.source || !b?.prompt) {
    return NextResponse.json({ error: "source+prompt required" }, { status: 400 });
  }
  await db.insert(schema.auditLog).values({
    userId: b.userId ?? 1,
    source: b.source,
    conversationId: b.conversationId ?? null,
    prompt: b.prompt,
    toolCalls: b.toolCalls ?? [],
    latencyMs: b.latencyMs ?? 0,
    status: b.status ?? "ok",
  });
  return NextResponse.json({ ok: true });
}
