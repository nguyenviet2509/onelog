# Phase 06 · Alert engine skeleton

**Priority:** P1 · **Status:** pending · **Depends on:** Phase 02

## Overview
Skeleton tối thiểu để admin alerts feed có data thật. Không build rule DSL phức tạp — chỉ 3 rule hardcode đủ demo + extensible.

## Schema
```ts
export const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: varchar("key", { length: 128 }).notNull(),      // e.g. "mcp.timeout"
  severity: varchar("severity", { length: 16 }).notNull(), // crit|warn|info
  message: text("message").notNull(),
  source: varchar("source", { length: 64 }),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  meta: jsonb("meta"),
});
```
Index: `(resolved_at NULLS FIRST, ts DESC)` cho "open alerts".

## Rule runner
`web/src/lib/alerts/runner.ts` — chạy mỗi 60s qua `setInterval` trong custom server hook hoặc Next instrumentation (`web/src/instrumentation.ts`).

3 rules MVP:
1. **mcp.timeout**: nếu trong 5 phút qua có ≥ 3 tool_call `ok=false` với name chứa "mcp" → fire crit.
2. **cost.spike**: SUM(cost_usd) 1h gần nhất > 1.5× SUM của 1h trước → warn.
3. **health.degraded**: gọi `/api/admin/health` internal, nếu `ok=false` → crit.

Dedupe: trước khi insert, check `key` đã có alert open chưa → skip nếu trùng.

Resolve: khi condition không match nữa → update `resolved_at = now()`.

## Acceptance
- [ ] `alerts` table tạo, migration apply.
- [ ] Rule runner start với app, log mỗi loop.
- [ ] Force fail MCP → row `alerts` crit xuất hiện trong < 90s.
- [ ] `/api/admin/alerts?status=open` trả list đúng.

## Files
- modify: `web/src/db/schema.ts`
- create: `web/src/lib/alerts/{runner,rules,dedupe}.ts`
- create: `web/src/instrumentation.ts` (Next 14 hook để boot runner)
- migration: `web/drizzle/0002_alerts.sql`

## Risk
- Background loop trong serverless = không chạy. App này deploy như long-lived Node (Dockerfile có sẵn) nên OK. Note ở docs nếu chuyển serverless về sau.
