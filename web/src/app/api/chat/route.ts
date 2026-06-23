/**
 * BFF proxy — POST /api/chat → agent /chat, pass SSE stream through.
 *
 * Why proxy at all (vs browser → agent direct):
 *   - Single origin for the browser (no CORS headache, simpler cookie story)
 *   - One place to add auth header injection / rate limit when ready
 *   - Hides internal agent URL from the public surface
 *
 * Streaming: Node runtime + ReadableStream + `dynamic = "force-dynamic"` so
 * Next never tries to cache or buffer.
 */
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT_URL = process.env.AGENT_URL || "http://agent:8080";

export async function POST(req: NextRequest) {
  const body = await req.text();

  const upstream = await fetch(`${AGENT_URL}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      // Stub auth header — agent middleware currently ignores, kept here so
      // the wire format is already in place when real auth lands.
      "X-User-Id": "sysadmin",
    },
    body,
    // Tell undici not to buffer; pipe straight to the client.
    // @ts-expect-error — duplex is required for streaming bodies but missing from RequestInit type
    duplex: "half",
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ type: "error", message: `upstream HTTP ${upstream.status}` })}\n\n`,
      { status: 200, headers: sseHeaders() },
    );
  }

  return new Response(upstream.body, { status: 200, headers: sseHeaders() });
}

function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    // Disable buffering on proxies like nginx/Caddy.
    "X-Accel-Buffering": "no",
  };
}
