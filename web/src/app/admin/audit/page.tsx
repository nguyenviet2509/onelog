"use client";

import { useCallback, useEffect, useState } from "react";

type Row = {
  id: string;
  userId: number;
  source: string;
  conversationId: string | null;
  prompt: string;
  toolCalls: { name: string; ok: boolean }[] | null;
  latencyMs: number;
  status: string;
  createdAt: string;
};

const SOURCES = ["", "web_chat", "alert", "mcp"] as const;

export default function AuditPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [source, setSource] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);

  const load = useCallback(async (reset: boolean) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (source) params.set("source", source);
      if (!reset && cursor) params.set("before", cursor);
      const r = await fetch(`/api/admin/audit?${params}`, { cache: "no-store" });
      const data = await r.json();
      setRows((prev) => (reset ? data.rows : [...prev, ...data.rows]));
      setCursor(data.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [source, cursor]);

  useEffect(() => {
    setCursor(null);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Audit log</h1>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-muted">Source</label>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="rounded border border-border bg-surface px-2 py-1"
          >
            {SOURCES.map((s) => (
              <option key={s || "_all"} value={s}>{s || "all"}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto rounded border border-border bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="bg-bg/40 text-muted">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Latency</th>
              <th className="px-3 py-2">Tools</th>
              <th className="px-3 py-2">Prompt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap px-3 py-2 font-mono">
                  {new Date(r.createdAt).toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td className="whitespace-nowrap px-3 py-2">{r.source}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className={r.status === "ok" ? "text-accent" : "text-err"}>{r.status}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono">{r.latencyMs} ms</td>
                <td className="px-3 py-2">
                  {(r.toolCalls ?? []).map((t, i) => (
                    <span
                      key={i}
                      className={"mr-1 inline-block rounded px-1.5 py-0.5 font-mono " +
                        (t.ok ? "bg-bg/60" : "bg-err/40")}
                      title={t.name}
                    >
                      {t.name}
                    </span>
                  ))}
                </td>
                <td className="max-w-md truncate px-3 py-2" title={r.prompt}>{r.prompt}</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted">Chưa có audit row</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex justify-center">
        {cursor && (
          <button
            onClick={() => load(false)}
            disabled={loading}
            className="rounded bg-surface px-4 py-1.5 text-sm hover:bg-bg/60 disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load older"}
          </button>
        )}
      </div>
    </div>
  );
}
