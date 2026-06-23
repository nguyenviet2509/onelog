import { ChatView } from "@/components/chat/chat-view";

export default function ChatPage() {
  return (
    <main className="mx-auto flex h-screen max-w-4xl flex-col px-4">
      <header className="flex items-center justify-between border-b border-border py-3">
        <h1 className="text-lg font-semibold tracking-tight">onelog</h1>
        <a
          href="/vmui/"
          target="_blank"
          rel="noreferrer"
          className="text-sm text-muted hover:text-fg"
        >
          Open vmui ↗
        </a>
      </header>
      <ChatView />
    </main>
  );
}
