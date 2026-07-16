/**
 * Drizzle schema — MVP slice 2: conversations + messages + minimal user seed.
 *
 * `messages.parts` is JSONB so we can round-trip the rich event stream
 * (thinking / tool_call / tool_result / answer) without flattening to text.
 * `content` is the human-readable rendition, used by sidebar previews + the
 * final `<a>` citation links.
 *
 * KB Phase 1 tables added below: kbEntries, kbEdits, kbTaxonomy, kbDrafts.
 * OpenWebUI pivot: no FK to users/conversations — auth via OpenWebUI JWT pass-through.
 */
import { integer, jsonb, pgTable, serial, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

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

export type User = typeof users.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;

// ---------------------------------------------------------------------------
// KB Phase 1 — OpenWebUI integration
// ---------------------------------------------------------------------------

/**
 * KB entries — resolved issues surfaced from OpenWebUI chats.
 * created_by: OpenWebUI user_id (VARCHAR, no FK — different domain).
 * openwebui_chat_id: OpenWebUI chat id (ULID/UUID-like string), NOT NULL UNIQUE.
 *   All entries MUST originate from an OpenWebUI chat. If manual-entry (admin
 *   path) is ever needed, revisit nullability then (YAGNI now).
 *   NOT NULL also avoids the Postgres UNIQUE-nullable footgun (multiple NULLs
 *   are treated as distinct, so UNIQUE alone wouldn't enforce 1-entry-per-chat).
 * verified_by: array of OpenWebUI user_ids who up-verified this entry.
 */
export const kbEntries = pgTable("kb_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  openwebuiChatId: varchar("openwebui_chat_id", { length: 64 }).notNull().unique(),
  title: varchar("title", { length: 200 }).notNull(),
  department: varchar("department", { length: 32 }),
  topic: varchar("topic", { length: 64 }),
  issueType: varchar("issue_type", { length: 64 }),
  tags: text("tags").array(),
  symptom: text("symptom").notNull(),
  rootCause: text("root_cause").notNull(),
  fix: text("fix").notNull(),
  embeddingId: varchar("embedding_id", { length: 64 }),
  createdBy: varchar("created_by", { length: 64 }).notNull(),
  upvotes: integer("upvotes").notNull().default(0),
  verifiedBy: text("verified_by").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * KB edits — audit trail of every field change after initial creation.
 * user_id: OpenWebUI user_id (VARCHAR, no FK).
 */
export const kbEdits = pgTable("kb_edits", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryId: uuid("entry_id").references(() => kbEntries.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id", { length: 64 }).notNull(),
  diffJson: jsonb("diff_json").notNull(),
  editedAt: timestamp("edited_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * KB taxonomy — controlled vocabulary for topic + issue_type + department.
 * usage_count bumped by /api/kb/entries on successful commit (not on snap).
 * Composite PK (kind, value) enforces uniqueness per dimension.
 */
export const kbTaxonomy = pgTable("kb_taxonomy", {
  kind: varchar("kind", { length: 32 }).notNull(),
  value: varchar("value", { length: 64 }).notNull(),
  usageCount: integer("usage_count").notNull().default(0),
});

/**
 * KB drafts — short-lived draft produced by /api/kb/summarize.
 * TTL enforced by expires_at (30 min default).
 * access_token: 32-byte hex random — passed in review URL, verified server-side.
 * openwebui_user_id: owner; checked when GET /kb/create loads the draft.
 */
export const kbDrafts = pgTable("kb_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  openwebuiChatId: varchar("openwebui_chat_id", { length: 64 }).notNull(),
  openwebuiUserId: varchar("openwebui_user_id", { length: 64 }).notNull(),
  draftJson: jsonb("draft_json").notNull(),
  accessToken: varchar("access_token", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type KbEntry = typeof kbEntries.$inferSelect;
export type KbEdit = typeof kbEdits.$inferSelect;
export type KbTaxonomy = typeof kbTaxonomy.$inferSelect;
export type KbDraft = typeof kbDrafts.$inferSelect;
