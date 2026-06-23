import Link from "next/link";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="border-b border-border p-3 text-sm font-semibold">Admin</div>
        <nav className="flex-1 overflow-y-auto py-2">
          <AdminLink href="/admin/audit" label="Audit log" />
          <AdminLink href="/admin/health" label="Health" />
        </nav>
        <div className="border-t border-border p-3 text-xs text-muted">
          <Link href="/chat" className="hover:text-fg">← back to chat</Link>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto px-6 py-4">{children}</main>
    </div>
  );
}

function AdminLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="block border-l-2 border-transparent px-3 py-2 text-sm hover:bg-bg/60 hover:border-accent"
    >
      {label}
    </Link>
  );
}
