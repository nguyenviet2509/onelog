"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";

type ConvListItem = { id: string; title: string; updatedAt: string };

export function Sidebar() {
  const pathname = usePathname();
  // /chat/<uuid> → uuid; /chat or anything else → undefined.
  const activeId = pathname?.startsWith("/chat/") ? pathname.slice("/chat/".length) : undefined;
  const [items, setItems] = useState<ConvListItem[]>([]);

  // Refresh on mount + when activeId changes (newly created conv) + on focus
  // so two tabs stay roughly in sync without WebSocket plumbing.
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch("/api/conversations", { cache: "no-store" });
        const data = await r.json();
        if (alive) setItems(data.conversations ?? []);
      } catch {}
    }
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [activeId]);

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface md:flex">
      <div className="flex items-center justify-between border-b border-border p-3">
        <span className="text-sm font-semibold">Conversations</span>
        <a
          href="/chat"
          className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-bg hover:opacity-90"
        >
          + New
        </a>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {items.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted">Chưa có conversation</p>
        ) : (
          items.map((c) => (
            <a
              key={c.id}
              href={`/chat/${c.id}`}
              className={cn(
                "block truncate border-l-2 px-3 py-2 text-sm hover:bg-bg/60",
                c.id === activeId ? "border-accent bg-bg/40" : "border-transparent",
              )}
              title={c.title}
            >
              {c.title}
            </a>
          ))
        )}
      </nav>
      <div className="border-t border-border p-3 text-xs text-muted">
        <a href="/trace" className="hover:text-fg">/trace ↗</a>
      </div>
    </aside>
  );
}
