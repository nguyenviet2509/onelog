"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";

type Check = { name: string; ok: boolean; latency_ms: number; detail?: string };
type HealthResponse = { ok: boolean; checks: Check[] };

export default function HealthPage() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  async function load() {
    setRefreshing(true);
    try {
      const r = await fetch("/api/admin/health", { cache: "no-store" });
      const json = (await r.json()) as HealthResponse;
      setData(json);
      setUpdatedAt(new Date());
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    // Auto-refresh every 10s — cheap probes, fine to poll.
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Health</h1>
          <p className="text-xs text-muted">
            {updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Loading…"}
            {refreshing && " · refreshing…"}
          </p>
        </div>
        <button
          onClick={load}
          disabled={refreshing}
          className="rounded bg-surface px-3 py-1 text-sm hover:bg-bg/60 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {!data ? null : (
        <>
          <div
            className={cn(
              "mb-4 rounded border px-4 py-2 text-sm",
              data.ok ? "border-accent/40 bg-accent/10 text-accent" : "border-err/40 bg-err/10 text-err",
            )}
          >
            Overall: <strong>{data.ok ? "HEALTHY" : "DEGRADED"}</strong>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {data.checks.map((c) => (
              <div
                key={c.name}
                className={cn(
                  "rounded border bg-surface p-4",
                  c.ok ? "border-accent/30" : "border-err/40",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold capitalize">{c.name}</span>
                  <span
                    className={cn(
                      "rounded px-2 py-0.5 text-xs font-medium",
                      c.ok ? "bg-accent/20 text-accent" : "bg-err/30 text-err",
                    )}
                  >
                    {c.ok ? "OK" : "DOWN"}
                  </span>
                </div>
                <div className="mt-2 text-xs text-muted">
                  Latency: <span className="font-mono">{c.latency_ms} ms</span>
                </div>
                {c.detail && (
                  <div className="mt-1 text-xs text-err">{c.detail}</div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
