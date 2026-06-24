# Phase 02 · Backend instrumentation (DB + cost calc)

**Priority:** P0 · **Status:** pending · **Depends on:** —

## Overview
Thêm tables để track LLM calls, tool calls, model pricing. Hook vào chat route để ghi mỗi request. Cost calc dùng pricing table.

## Schema additions (drizzle migration)
Edit `web/src/db/schema.ts`:

```ts
export const llmCalls = pgTable("llm_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").references(() => conversations.id),
  messageId: uuid("message_id"),
  model: varchar("model", { length: 64 }).notNull(),
  promptTokens: integer("prompt_tokens").notNull(),
  completionTokens: integer("completion_tokens").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  costUsd: integer("cost_usd_micro").notNull(), // store as micro-USD (int)
  ok: boolean("ok").notNull().default(true),
  errorCode: varchar("error_code", { length: 64 }),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
});

export const toolCalls = pgTable("tool_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").references(() => conversations.id),
  toolName: varchar("tool_name", { length: 128 }).notNull(),
  latencyMs: integer("latency_ms").notNull(),
  ok: boolean("ok").notNull().default(true),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
});

export const modelPricing = pgTable("model_pricing", {
  model: varchar("model", { length: 64 }).primaryKey(),
  inputPer1k: integer("input_per_1k_micro").notNull(),  // micro-USD per 1k input tokens
  outputPer1k: integer("output_per_1k_micro").notNull(),
  effectiveFrom: timestamp("effective_from").defaultNow().notNull(),
});
```

Indexes: `llm_calls(ts desc)`, `llm_calls(model, ts)`, `tool_calls(tool_name, ts)`.

## Pricing seed
`web/src/db/seed-pricing.ts`:
```ts
const seed = [
  { model: "claude-sonnet-4-6", inputPer1k: 3000, outputPer1k: 15000 },   // micro-USD
  { model: "claude-haiku-4-5-20251001", inputPer1k: 800, outputPer1k: 4000 },
  { model: "claude-opus-4-7", inputPer1k: 15000, outputPer1k: 75000 },
];
// upsert on conflict do update
```
Run from `bootstrap.ts` once. Override via env `MODEL_PRICING_JSON` (optional, parse on boot).

## Chat route hook
Edit `web/src/app/api/chat/route.ts`:
- Sau khi nhận response từ Anthropic SDK, đọc `usage.input_tokens`, `usage.output_tokens`, đo latency.
- Lookup pricing → insert `llm_calls`.
- Mỗi tool call → insert `tool_calls` row.
- Failure path: insert `ok=false`, `errorCode`.

Helper: `web/src/lib/instrumentation.ts` export `recordLlmCall()`, `recordToolCall()`.

## Acceptance
- [ ] Drizzle migration generated & applied (dev DB).
- [ ] `model_pricing` table seeded với 3 models.
- [ ] Mỗi chat request tạo ≥1 row `llm_calls` với cost > 0.
- [ ] Mỗi tool call tạo 1 row `tool_calls`.
- [ ] Failure path ghi `ok=false`.

## Files
- modify: `web/src/db/schema.ts`, `web/src/db/bootstrap.ts`, `web/src/app/api/chat/route.ts`
- create: `web/src/lib/instrumentation.ts`, `web/src/db/seed-pricing.ts`
- migration: `web/drizzle/0001_metrics.sql` (generated)

## Risk
- Pricing drift → table có `effective_from`, lookup theo `ts <= now()` ORDER BY `effective_from DESC` LIMIT 1.
- Token counting: trust SDK `usage` field; nếu null thì record `0` + log warn.
