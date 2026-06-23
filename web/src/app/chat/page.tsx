import { ChatView } from "@/components/chat/chat-view";

// New conversation — empty history. BFF creates the row lazily on first send
// and reports the id via the X-Conversation-Id response header.
export default function ChatNewPage() {
  return <ChatView />;
}
