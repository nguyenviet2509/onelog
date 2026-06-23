/**
 * BFF /api/chat — Postgres-aware version.
 *
 * Flow:
 *  1. Insert the user message immediately so it survives even if upstream dies.
 *  2. Pipe SSE stream from agent to client unchanged (no buffering).
 *  3. In parallel, tee bytes through a parser that accumulates `parts` and a
 *     final answer string, then persists the assistant message when the
 *     upstream closes.
 *  4. Auto-title the conversation from the first user query.
 *
 * If `conversationId` is missing, an empty conversation is created on the fly.
 */
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";

import { ensureBootstrap } from "@/db/bootstrap";
import { getDb, schema } from "@/db/client";
import { getCurrentUser } from "@/lib/auth-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT_URL = process.env.AGENT_URL || "http://agent:8080";

type Part =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown; output?: unknown };

export async function POST(req: NextRequest) {
  await ensureBootstrap();
  const user = getCurrentUser();
  const db = getDb();

  const body = (await req.json()) as { query: string; conversationId?: string };
  const query = String(body.query || "").trim();
  if (!query) return new Response("missing query", { status: 400 });

  // Resolve or create conversation.
  let conversationId = body.conversationId;
  let isFirstMessage = false;
  if (!conversationId) {
    const [row] = await db
      .insert(schema.conversations)
      .values({ userId: user.id, title: titleFromQuery(query) })
      .returning({ id: schema.conversations.id });
    conversationId = row.id;
    isFirstMessage = true;
  } else {
    isFirstMessage = await isFirstQuery(db, conversationId);
  }

  // Persist user message up front.
  await db.insert(schema.messages).values({
    conversationId,
    role: "user",
    content: query,
    parts: [{ kind: "text", text: query }],
  });

  if (isFirstMessage) {
    await db
      .update(schema.conversations)
      .set({ title: titleFromQuery(query), updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversationId));
  }

  // Open upstream agent stream.
  const upstream = await fetch(`${AGENT_URL}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-User-Id": String(user.id),
    },
    body: JSON.stringify({ query }),
    // @ts-expect-error — duplex required for streaming body; missing in RequestInit types
    duplex: "half",
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ type: "error", message: `upstream HTTP ${upstream.status}` })}\n\n`,
      { status: 200, headers: sseHeaders(conversationId) },
    );
  }

  // Tee stream: client gets bytes as-is; we accumulate parts + final text and
  // persist on flush. No throughput cost beyond the parse loop.
  const decoder = new TextDecoder();
  let buf = "";
  let currentEvent = "message";
  const parts: Part[] = [];
  let finalText = "";

  const tee = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";
      for (const block of blocks) {
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        applyToParts(currentEvent, safeJson(data), parts);
        if (currentEvent === "answer") {
          const t = safeJson(data)?.text;
          if (typeof t === "string") finalText = t;
        }
      }
    },
    async flush() {
      try {
        await db.insert(schema.messages).values({
          conversationId: conversationId!,
          role: "assistant",
          content: finalText || "(no answer)",
          parts,
        });
        await db
          .update(schema.conversations)
          .set({ updatedAt: new Date() })
          .where(eq(schema.conversations.id, conversationId!));
      } catch (err) {
        // Best-effort persist; don't break the response if DB hiccups.
        console.error("chat.persist_failed", err);
      }
    },
  });

  return new Response(upstream.body.pipeThrough(tee), {
    status: 200,
    headers: sseHeaders(conversationId),
  });
}

function sseHeaders(conversationId: string): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Conversation-Id": conversationId,
  };
}

function titleFromQuery(q: string): string {
  return q.length > 80 ? q.slice(0, 77) + "…" : q;
}

async function isFirstQuery(db: ReturnType<typeof getDb>, convId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, convId))
    .limit(1);
  return rows.length === 0;
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

function applyToParts(event: string, payload: any, parts: Part[]): void {
  if (!payload) return;
  switch (event) {
    case "thinking":
      parts.push({ kind: "text", text: payload.text ?? "" });
      break;
    case "tool_call":
      parts.push({ kind: "tool", name: payload.name ?? "tool", input: payload.input });
      break;
    case "tool_result":
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.kind === "tool" && p.output === undefined) {
          p.output = payload.output;
          break;
        }
      }
      break;
    case "answer":
      parts.push({ kind: "text", text: "\n" + (payload.text ?? "") });
      break;
  }
}
