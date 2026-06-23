"use client";

import { useEffect, useRef, useState } from "react";

import { splitCitations } from "@/lib/citation";
import { cn } from "@/lib/cn";
import { streamSSE } from "@/lib/sse-client";

type Role = "user" | "assistant";

type ToolPart = {
  kind: "tool";
  name: string;
  input: unknown;
  output?: unknown;
};

type TextPart = { kind: "text"; text: string };

type Message = {
  role: Role;
  parts: (TextPart | ToolPart)[];
  status?: "streaming" | "done" | "error";
};

export function ChatView() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const query = input.trim();
    if (!query || busy) return;

    setInput("");
    setBusy(true);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setMessages((m) => [
      ...m,
      { role: "user", parts: [{ kind: "text", text: query }], status: "done" },
      { role: "assistant", parts: [], status: "streaming" },
    ]);

    try {
      for await (const ev of streamSSE("/api/chat", { query }, ac.signal)) {
        const payload = safeJson(ev.data);
        setMessages((m) => applyEvent(m, ev.event, payload));
      }
    } catch (err) {
      setMessages((m) =>
        m.map((msg, i) =>
          i === m.length - 1 && msg.role === "assistant"
            ? { ...msg, status: "error", parts: [...msg.parts, { kind: "text", text: `\n_(stream error: ${(err as Error).message})_` }] }
            : msg,
        ),
      );
    } finally {
      setBusy(false);
      setMessages((m) =>
        m.map((msg, i) =>
          i === m.length - 1 && msg.role === "assistant" && msg.status === "streaming"
            ? { ...msg, status: "done" }
            : msg,
        ),
      );
    }
  }

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-6">
        {messages.length === 0 ? <Welcome /> : <MessageList messages={messages} />}
      </div>
      <form onSubmit={onSubmit} className="border-t border-border py-3">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Hỏi về log… ví dụ: mysql có lỗi gì gần đây?"
            className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent"
            disabled={busy}
            autoFocus
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg disabled:opacity-50"
          >
            {busy ? "…" : "Send"}
          </button>
        </div>
      </form>
    </>
  );
}

function Welcome() {
  return (
    <div className="mx-auto max-w-md py-12 text-center text-muted">
      <h2 className="mb-2 text-xl font-semibold text-fg">Log Investigation Assistant</h2>
      <p className="text-sm">
        Hỏi câu hỏi về log. Mỗi kết luận sẽ có citation
        <code className="mx-1 rounded bg-surface px-1 py-0.5 text-xs">[service:host:ts]</code>
        click để mở vmui xem raw log.
      </p>
    </div>
  );
}

function MessageList({ messages }: { messages: Message[] }) {
  return (
    <div className="flex flex-col gap-4">
      {messages.map((m, i) => (
        <Bubble key={i} msg={m} />
      ))}
    </div>
  );
}

function Bubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
          isUser ? "bg-accent text-bg" : "bg-surface text-fg",
          msg.status === "error" && "border border-err",
        )}
      >
        {msg.parts.length === 0 && !isUser && (
          <span className="text-muted">đang suy nghĩ…</span>
        )}
        {msg.parts.map((p, i) =>
          p.kind === "text" ? <TextSegment key={i} text={p.text} /> : <ToolCard key={i} part={p} />,
        )}
      </div>
    </div>
  );
}

function TextSegment({ text }: { text: string }) {
  const segs = splitCitations(text);
  return (
    <p className="whitespace-pre-wrap">
      {segs.map((s, i) =>
        s.kind === "text" ? (
          <span key={i}>{s.text}</span>
        ) : (
          <a
            key={i}
            href={s.href}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-accent underline-offset-2 hover:underline"
            title={`${s.service} · ${s.host}${s.ts ? " · " + s.ts : ""}`}
          >
            {s.raw}
          </a>
        ),
      )}
    </p>
  );
}

function ToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="my-2 rounded-lg border border-border bg-bg/40 text-xs"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none px-3 py-1.5 text-muted">
        🔧 <span className="font-mono">{part.name}</span>
        {!part.output && <span className="ml-2 italic">…running</span>}
      </summary>
      <div className="grid gap-2 border-t border-border px-3 py-2">
        <Pre label="input" value={part.input} />
        {part.output !== undefined && <Pre label="result" value={part.output} />}
      </div>
    </details>
  );
}

function Pre({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-muted">{label}</div>
      <pre className="max-h-60 overflow-auto rounded bg-bg px-2 py-1 font-mono text-[11px] leading-tight">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return { type: "raw", raw: s };
  }
}

// Reducer-style: produce next messages array given an SSE event.
function applyEvent(
  messages: Message[],
  event: string,
  payload: any,
): Message[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "assistant") return messages;

  const next = (parts: Message["parts"], patch?: Partial<Message>): Message[] => {
    const updated = { ...last, parts, ...patch };
    return [...messages.slice(0, -1), updated];
  };

  switch (event) {
    case "thinking":
      return next([...last.parts, { kind: "text", text: payload?.text ?? "" }]);
    case "tool_call":
      return next([
        ...last.parts,
        { kind: "tool", name: payload?.name ?? "tool", input: payload?.input },
      ]);
    case "tool_result": {
      // Attach output to the most recent tool part with matching id (or last open one).
      const parts = [...last.parts];
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.kind === "tool" && p.output === undefined) {
          parts[i] = { ...p, output: payload?.output };
          break;
        }
      }
      return next(parts);
    }
    case "answer":
      return next([...last.parts, { kind: "text", text: "\n" + (payload?.text ?? "") }], {
        status: "done",
      });
    case "error":
      return next([...last.parts, { kind: "text", text: `\n_(error: ${payload?.message ?? "unknown"})_` }], {
        status: "error",
      });
    default:
      return messages;
  }
}
