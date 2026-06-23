/**
 * Drizzle schema — MVP slice 2: conversations + messages + minimal user seed.
 *
 * `messages.parts` is JSONB so we can round-trip the rich event stream
 * (thinking / tool_call / tool_result / answer) without flattening to text.
 * `content` is the human-readable rendition, used by sidebar previews + the
 * final `<a>` citation links.
 */
import { jsonb, pgTable, serial, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

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

export type User = typeof users.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
