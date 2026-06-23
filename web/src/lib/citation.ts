/**
 * Citation `[service:host:timestamp]` → vmui deep-link.
 *
 * The agent enforces this format. We split the answer text into text + link
 * segments so we can render citations as clickable anchors that open vmui
 * with a LogsQL filter for the cited stream.
 */

const CITATION_RE = /\[([a-zA-Z0-9._-]+):([a-zA-Z0-9._-]+)(?::([^\]]+))?\]/g;

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "citation"; raw: string; service: string; host: string; ts?: string; href: string };

export function splitCitations(text: string): Segment[] {
  const out: Segment[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(CITATION_RE)) {
    const [raw, service, host, ts] = m;
    if (m.index !== undefined && m.index > lastIndex) {
      out.push({ kind: "text", text: text.slice(lastIndex, m.index) });
    }
    out.push({ kind: "citation", raw, service, host, ts, href: vmuiHref(service, host, ts) });
    lastIndex = (m.index ?? 0) + raw.length;
  }
  if (lastIndex < text.length) {
    out.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return out;
}

function vmuiHref(service: string, host: string, ts?: string): string {
  // vmui accepts `query=` for LogsQL. Filter by stream fields + window the
  // citation timestamp ±1 minute so the user sees surrounding context.
  let query = `service:${quote(service)} AND host:${quote(host)}`;
  const params = new URLSearchParams({ query });
  if (ts) {
    const t = new Date(ts);
    if (!Number.isNaN(t.getTime())) {
      const start = new Date(t.getTime() - 60_000).toISOString();
      const end = new Date(t.getTime() + 60_000).toISOString();
      params.set("start", start);
      params.set("end", end);
    }
  }
  return `/vmui/?${params.toString()}`;
}

function quote(v: string): string {
  return v.includes(" ") || v.includes(":") ? `"${v}"` : v;
}
