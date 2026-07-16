/**
 * POST /api/kb/internal/cleanup-drafts
 *
 * Internal endpoint — deletes expired kb_drafts rows.
 * Protected by INTERNAL_CRON_TOKEN header: x-internal-token must match env.
 *
 * Designed to be called by an external scheduler (systemd timer, cron, or
 * docker health-check sidecar) once per hour:
 *   curl -s -X POST http://web:3000/api/kb/internal/cleanup-drafts \
 *        -H "x-internal-token: $INTERNAL_CRON_TOKEN"
 *
 * Also called opportunistically (fire-and-forget) from /api/kb/summarize on
 * every request as a safety net when no external cron is configured.
 *
 * Deployment note: set INTERNAL_CRON_TOKEN to a random 32-byte hex string.
 *   openssl rand -hex 32
 */

import { NextRequest, NextResponse } from "next/server";
import { cleanupExpiredDrafts } from "@/lib/kb/draft-store";
import { ensureBootstrap } from "@/db/bootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cronToken = process.env.INTERNAL_CRON_TOKEN;
  if (!cronToken) {
    // Env not set — refuse to run (fail closed, not open) to avoid unprotected
    // GC endpoint in production.
    return NextResponse.json(
      { error: "INTERNAL_CRON_TOKEN not configured" },
      { status: 503 },
    );
  }

  const provided = req.headers.get("x-internal-token") ?? "";
  if (provided !== cronToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureBootstrap();

  let deleted: number;
  try {
    deleted = await cleanupExpiredDrafts();
  } catch (err) {
    console.error("kb.cleanup_drafts.failed", err);
    return NextResponse.json({ error: "Cleanup failed" }, { status: 500 });
  }

  console.info(`kb.cleanup_drafts.ok deleted=${deleted}`);
  return NextResponse.json({ deleted }, { status: 200 });
}
