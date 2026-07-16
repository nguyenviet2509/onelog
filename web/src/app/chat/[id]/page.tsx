import { and, asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { ChatView, type Message } from "@/components/chat/chat-view";
import { ensureBootstrap } from "@/db/bootstrap";
import { getDb, schema } from "@/db/client";
import { getCurrentUser } from "@/lib/auth-stub";
import { MarkResolvedButton } from "./mark-resolved-button";

export const dynamic = "force-dynamic";

export default async function ChatByIdPage({ params }: { params: { id: string } }) {
  await ensureBootstrap();
  const user = getCurrentUser();
  const db = getDb();

  const [conv] = await db
    .select({ id: schema.conversations.id, title: schema.conversations.title })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, params.id),
        eq(schema.conversations.userId, user.id),
      ),
    )
    .limit(1);
  if (!conv) notFound();

  const rows = await db
    .select({
      role: schema.messages.role,
      content: schema.messages.content,
      parts: schema.messages.parts,
    })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, params.id))
    .orderBy(asc(schema.messages.createdAt));

  const initialMessages: Message[] = rows.map((r) => ({
    role: r.role as Message["role"],
    parts: (r.parts as Message["parts"]) ?? [{ kind: "text", text: r.content }],
    status: "done",
  }));

  return (
    <div className="flex flex-col h-full">
      {/* Conversation header with Mark Resolved button */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2 shrink-0">
        <span className="truncate text-sm font-medium text-fg max-w-[70%]" title={conv.title}>
          {conv.title}
        </span>
        <MarkResolvedButton conversationId={params.id} />
      </div>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <ChatView initialConversationId={params.id} initialMessages={initialMessages} />
      </div>
    </div>
  );
}
