/**
 * Drizzle schema — MVP slice 2: conversations + messages + minimal user seed.
 *
 * `messages.parts` is JSONB so we can round-trip the rich event stream
 * (thinking / tool_call / tool_result / answer) without flattening to text.
 * `content` is the human-readable rendition, used by sidebar previews + the
 * final `<a>` citation links.
 *
 * KB tables (Phase 1): kbEntries, kbEdits, kbTaxonomy
 */
import { integer, jsonb, pgTable, primaryKey, serial, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 128 }),
  role: varchar("role", { length: 32 }).notNull().default("admin"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: serial("user_id").references(() => users.id).notNull(),
  title: varchar("title", { length: 200 }).notNull().default("New conversation"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }).notNull(),
  role: varchar("role", { length: 16 }).notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  parts: jsonb("parts"), // raw event-derived parts for replay; null for user msgs
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Audit log — append-only record of every chat / alert / mcp invocation.
 * Used by /admin/audit for ops visibility + future cost dashboard.
 *
 * `tool_calls` jsonb captures tool name + input/output digest per turn so we
 * can compute aggregate stats without re-parsing message parts.
 */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: serial("user_id").references(() => users.id).notNull(),
  source: varchar("source", { length: 32 }).notNull(), // web_chat | alert | mcp
  conversationId: uuid("conversation_id"), // null for non-chat sources
  prompt: text("prompt").notNull(),
  toolCalls: jsonb("tool_calls"), // array of {name, input, ok}
  latencyMs: integer("latency_ms").notNull().default(0),
  status: varchar("status", { length: 16 }).notNull().default("ok"), // ok | error
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * KB taxonomy — master list of allowed departments / topics / issue_types.
 * Auto-populated by taxonomy-snap when LLM proposes a value not yet present.
 * usage_count drives popularity sort in browse UI (Phase 2).
 */
export const kbTaxonomy = pgTable("kb_taxonomy", {
  kind: varchar("kind", { length: 16 }).notNull(), // department | topic | issue_type
  value: varchar("value", { length: 64 }).notNull(),
  usageCount: integer("usage_count").notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.kind, t.value] }),
}));

/**
 * KB entries — curated knowledge extracted from resolved conversations.
 * Fields redacted before storage; embedding_id links to Qdrant point.
 */
export const kbEntries = pgTable("kb_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  // ON DELETE SET NULL: preserve KB knowledge even if source conversation is deleted.
  // Nullable + unique: at most one KB entry per conversation (enforces backfill dedup assumption).
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  title: varchar("title", { length: 200 }).notNull(),
  department: varchar("department", { length: 32 }),   // SRE | DBA | NetOps | AppDev | Security
  topic: varchar("topic", { length: 64 }),              // mysql | rsyslog | vmalert | disk | ssh
  issueType: varchar("issue_type", { length: 64 }),    // disk-full | brute-force | oom | crash-loop
  tags: text("tags").array(),                           // free-form: host, service, error code
  symptom: text("symptom").notNull(),
  rootCause: text("root_cause").notNull(),
  fix: text("fix").notNull(),
  embeddingId: varchar("embedding_id", { length: 128 }),// Qdrant point id (same as entry id)
  createdBy: integer("created_by").references(() => users.id).notNull(),
  upvotes: integer("upvotes").notNull().default(0),
  verifiedBy: integer("verified_by").array(),           // user ids who verified
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // Nullable unique: allows NULL (no source conversation) but prevents duplicate entries
  // from the same conversation. Backfill dedup logic relies on this invariant.
  uniqueConversation: unique("uq_kb_entries_conversation_id").on(t.conversationId),
}));

/**
 * KB edits — append-only audit trail of every field change to a KB entry.
 * diff_json: { field: { before: string, after: string } }[]
 */
export const kbEdits = pgTable("kb_edits", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryId: uuid("entry_id").references(() => kbEntries.id, { onDelete: "cascade" }).notNull(),
  userId: integer("user_id").references(() => users.id).notNull(),
  diffJson: jsonb("diff_json").notNull(),
  editedAt: timestamp("edited_at", { withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
export type KbEntry = typeof kbEntries.$inferSelect;
export type KbEdit = typeof kbEdits.$inferSelect;
export type KbTaxonomy = typeof kbTaxonomy.$inferSelect;
