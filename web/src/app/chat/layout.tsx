import { Sidebar } from "@/components/chat/sidebar";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex flex-1 flex-col px-4">
        <header className="flex items-center justify-between border-b border-border py-3">
          <h1 className="text-lg font-semibold tracking-tight">onelog</h1>
          <div className="flex gap-3 text-sm text-muted">
            <a href="/trace" className="hover:text-fg">Trace</a>
            <a href="/admin" className="hover:text-fg">Admin</a>
            <a href="/select/vmui/" target="_blank" rel="noreferrer" className="hover:text-fg">
              vmui ↗
            </a>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
