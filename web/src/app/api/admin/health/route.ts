/**
 * GET /api/admin/health — fan-out health probes to each backend.
 *
 * Each probe has its own 2s timeout and returns either ok+latency or error+msg.
 * No long-lived state; this endpoint is cheap to refresh from the admin UI.
 */
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { ensureBootstrap } from "@/db/bootstrap";
import { getDb } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT_URL = process.env.AGENT_URL || "http://agent:8080";
const VL_URL = process.env.VL_URL || "http://victorialogs:9428";
const QDRANT_URL = process.env.QDRANT_URL || "http://qdrant:6333";

type Check = { name: string; ok: boolean; latency_ms: number; detail?: string };

async function probeHttp(name: string, url: string): Promise<Check> {
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    return {
      name,
      ok: res.ok,
      latency_ms: Date.now() - start,
      detail: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (e) {
    return { name, ok: false, latency_ms: Date.now() - start, detail: (e as Error).message };
  }
}

async function probePostgres(): Promise<Check> {
  const start = Date.now();
  try {
    await ensureBootstrap();
    const db = getDb();
    // Tiny no-op query — confirms pool + auth + DDL ran.
    await db.execute(sql`SELECT 1`);
    return { name: "postgres", ok: true, latency_ms: Date.now() - start };
  } catch (e) {
    return { name: "postgres", ok: false, latency_ms: Date.now() - start, detail: (e as Error).message };
  }
}

export async function GET() {
  const probes = await Promise.all([
    probeHttp("agent", `${AGENT_URL}/health`),
    probeHttp("victorialogs", `${VL_URL}/health`),
    probeHttp("qdrant", `${QDRANT_URL}/`),
    probePostgres(),
  ]);
  const allOk = probes.every((p) => p.ok);
  return NextResponse.json({ ok: allOk, checks: probes });
}
