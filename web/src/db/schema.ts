/**
 * Drizzle schema — MVP slice 2: conversations + messages + minimal user seed.
 *
 * `messages.parts` is JSONB so we can round-trip the rich event stream
 * (thinking / tool_call / tool_result / answer) without flattening to text.
 * `content` is the human-readable rendition, used by sidebar previews + the
 * final `<a>` citation links.
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
