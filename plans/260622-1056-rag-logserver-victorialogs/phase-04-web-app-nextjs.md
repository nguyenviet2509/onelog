# Phase 04 — Web app Next.js (chat + trace + admin + settings)

## Context
- Plan: [plan.md](plan.md)
- Re-scope: [brainstorm Web+MCP](../reports/brainstorm-260622-1113-rag-web-ui-and-mcp-rescope.md)

## Overview
- Priority: P0 (primary UX)
- Status: **MVP slice (chat only) scaffolded 2026-06-23**. Next.js 14 + Tailwind + tiny inline shadcn-style components. `/chat` page với SSE consume, citation parser → vmui deep-link, tool call cards collapsible. BFF `/api/chat` proxy SSE → agent. Caddy reverse_proxy / → web:3000 (flush_interval -1 cho streaming). Deferred slice 2: Postgres conv history, `/trace` embed vmui, `/admin/*`, settings, auth login.
- Mục tiêu: Web app Next.js cho sysadmin Q&A, trace log interactive, admin panel, settings. **Auth defer** (truy cập thẳng MVP, IP whitelist ở Caddy), conversation persistent Postgres, streaming SSE. Auth thật (email/pass hoặc SSO) bổ sung sau.

## Requirements
- Sysadmin desktop, 2-3 user đồng thời
- p95 chat 1-turn < 8s
- Trace page = iframe vmui (effort ~1 ngày thay vì 5 ngày tự code)
- Conversation persistent, share link
- Role admin/viewer
- Mobile-friendly (responsive, không phải native)

## Architecture
```
Browser
  │ HTTPS
  ▼
[Caddy] ─── /        → [Next.js Web :3000]
        └── /api/*   → [Next.js BFF routes]
                          │ JWT bearer
                          ▼
                    [Agent FastAPI :8080]
                    /chat (SSE), /trace, /admin/*
                          │
                    Postgres / Qdrant / VictoriaLogs
```

Next.js BFF làm proxy + auth boundary. Browser KHÔNG gọi trực tiếp agent.

## Pages

| Route | Mô tả | Role |
|---|---|---|
| `/chat` (default) | Chat ChatGPT-like, sidebar history | open (MVP) |
| `/chat/[id]` | Open conversation | open (MVP) |
| `/trace` | Log explorer (filter/table/histogram) | open (MVP) |
| `/admin/audit` | Audit log table | open (MVP) |
| `/admin/cost` | Cost dashboard | open (MVP) |
| `/admin/eval` | Eval runs + trigger | open (MVP) |
| `/admin/users` | User CRUD (MVP: dummy single user "sysadmin") | open (MVP) |
| `/admin/health` | System health | open (MVP) |
| `/settings` | Profile, theme, MCP token | open (MVP) |

**Note**: MVP không có `/login`, không guard role. Tạm tin IP whitelist + VPN. Khi auth chốt sẽ thêm `/login` + middleware role guard. Layout đã reserve placeholder `<UserMenu user={currentUser}/>` lấy từ context để dễ swap sau.

## Related Code Files
Create:
- `web/package.json`
- `web/next.config.ts`
- `web/tsconfig.json`
- `web/drizzle.config.ts`
- `web/src/db/schema.ts` (users, conversations, messages, audit_log, eval_runs, eval_results, api_tokens)
- `web/src/db/client.ts`
- `web/src/auth/stub.ts` (defer: return fixed user "sysadmin", role admin; thay bằng Auth.js sau)
- `web/src/middleware.ts` (MVP: no-op pass-through; sau plug guard)
- `web/src/app/layout.tsx`
- `web/src/app/(app)/chat/page.tsx`
- `web/src/app/(app)/chat/[id]/page.tsx`
- `web/src/app/(app)/trace/page.tsx`
- `web/src/app/(app)/settings/page.tsx`
- `web/src/app/(admin)/admin/audit/page.tsx`
- `web/src/app/(admin)/admin/cost/page.tsx`
- `web/src/app/(admin)/admin/eval/page.tsx`
- `web/src/app/(admin)/admin/users/page.tsx`
- `web/src/app/(admin)/admin/health/page.tsx`
- `web/src/app/api/chat/route.ts` (SSE proxy to agent)
- `web/src/app/api/trace/route.ts` (LogsQL passthrough)
- `web/src/app/api/admin/*/route.ts`
- `web/src/app/api/tokens/route.ts` (MCP token CRUD)
- `web/src/components/chat/message-list.tsx`
- `web/src/components/chat/input.tsx`
- `web/src/components/chat/citation-popover.tsx`
- `web/src/components/chat/tool-call-card.tsx`
- `web/src/components/trace/vmui-iframe.tsx` (embed VictoriaLogs vmui)
- `web/src/components/trace/ask-ai-overlay.tsx` (top bar overlay với Ask AI button)
- **BỎ**: filter-sidebar, log-table, histogram, logsql-editor — tận dụng vmui built-in của VictoriaLogs
- `web/src/components/admin/cost-chart.tsx`
- `web/src/components/admin/audit-table.tsx`
- `web/src/components/ui/*` (shadcn install)
- `web/src/lib/agent-client.ts` (typed fetch agent)
- `web/src/lib/sse-stream.ts`
- `web/Dockerfile`
- `infra/docker-compose.yml` (add `web` service)
- `infra/caddy/Caddyfile`

Update:
- `infra/.env.example` (+web env)

## Implementation Steps
1. **Scaffold**: `pnpm create next-app web --ts --app --tailwind --eslint`
2. Install: `shadcn`, `drizzle-orm pg`, `@tanstack/react-query`, `@tanstack/react-table` (cho audit table), `recharts` (cho cost chart). **BỎ**: `@tanstack/react-virtual` (không cần vì trace dùng vmui). **KHÔNG cài `next-auth` ở MVP** — defer.
3. Init shadcn, generate components (button, input, dialog, sheet, table, card, badge, toast, dropdown)
4. **DB schema** (Drizzle): theo brainstorm report §5, migration script
5. **Auth defer** (MVP):
   - `auth/stub.ts` export `getCurrentUser()` → `{id: 1, email: "sysadmin@local", name: "sysadmin", role: "admin"}`
   - Seed Postgres 1 row users id=1
   - Mọi BFF route gắn `X-User-Id: 1` header khi gọi agent
   - Interface giữ giống thật để swap không sửa route
6. **Middleware**: MVP no-op; comment `// TODO: plug auth guard when ready`
7. **Chat page**:
   - Sidebar conversation list (TanStack Query, persistent)
   - Main message area markdown render (react-markdown + rehype-highlight)
   - Input box + send button → POST `/api/chat`, consume SSE stream
   - Citation parse `[svc:host:ts]` → click mở Sheet với raw log từ `/api/trace`
   - Tool call card collapsible (show tool name + args + result preview)
8. **Trace page (embed vmui)**:
   - Thin top bar: web nav + "Ask AI about this view" button + "↗ Mở full vmui" link
   - `<iframe src="/vmui/" class="w-full h-full">` — Caddy reverse proxy `/vmui/*` → `victorialogs:9428/select/vmui/*`
   - "Ask AI" button: parse current vmui URL query params (LogsQL, time range) hoặc dùng `postMessage` listener → POST `/api/chat` tạo conversation mới với context pre-filled → redirect `/chat/{id}`
   - Chat citation `[svc:host:ts]` deep-link: `<a href="/vmui/?query=_stream:{service=...}+AND+_time:[ts1..ts2]" target="_blank">`
   - KHÔNG tự code filter/histogram/table/editor — vmui đã có
   - Tiết kiệm ~5 ngày so plan cũ
9. **Admin pages**:
   - Audit: TanStack Table với filter user/source/action, pagination server-side
   - Cost: line chart 30 ngày, breakdown table by user/tool/model
   - Eval: list runs, button "Trigger new run" → POST `/api/admin/eval/run`, poll status
   - Users: CRUD, set role
   - Health: cards trạng thái VL/Qdrant/agent/redis (ping endpoints)
10. **Settings**:
    - Profile readonly từ OIDC
    - Theme toggle (next-themes)
    - MCP token section: list tokens, button "Generate" → modal show token 1 lần + config snippet, button "Revoke"
11. **BFF API routes**: forward request + attach JWT bearer (từ session) → agent. SSE: pipe `Response.body` stream từ agent về client
12. **Dockerfile**: multi-stage, output `standalone`, serve qua node
13. **Caddyfile**: TLS, reverse proxy `/` → web:3000, `/vmui/*` → victorialogs:9428/select/vmui/* (rewrite), `/api/agent/*` → agent:8080 (chỉ dùng nếu cần bypass BFF cho debug)
14. **Smoke test**: login OIDC, chat 1 câu, trace filter, admin audit hiển thị

## Todo
- [ ] Scaffold Next.js + shadcn + Tailwind
- [ ] Drizzle schema + migration
- [ ] Auth stub (defer) + seed user "sysadmin" + middleware no-op
- [ ] (Sau) Plug auth thật: email/pass (Better Auth) hoặc SSO (Auth.js v5)
- [ ] Layout + sidebar nav
- [ ] Chat page (message list, input, SSE)
- [ ] Citation popover + tool call card
- [ ] Trace page (filter + table + histogram)
- [ ] LogsQL editor advanced
- [ ] Admin audit page
- [ ] Admin cost dashboard
- [ ] Admin eval page (trigger + list)
- [ ] Admin users CRUD
- [ ] Admin health page
- [ ] Settings + theme + MCP token UI
- [ ] BFF API routes (chat SSE, trace, admin proxies)
- [ ] Dockerfile multi-stage standalone
- [ ] Caddyfile integration
- [ ] E2E smoke test
- [ ] Doc user-guide.md

## Success Criteria
- Chat streaming hiển thị progressive < 1s first token
- Trace page render 10k log lines mượt (< 2s)
- Histogram click drill-down work
- Citation click mở raw log đúng window
- Admin pages truy cập được (MVP open, sẽ guard sau)
- Cost dashboard chính xác theo audit_log
- Eval trigger từ UI → kết quả lưu Postgres
- MCP token generate + revoke work
- Mobile layout không vỡ (chat usable, trace acceptable)

## Risks
- **Frontend skill gap**: Next.js 15 + RSC + Auth.js v5 đều mới, team Python-only sẽ struggle → consider FastAPI+HTMX fallback nếu blocker
- **SSE proxy qua BFF**: streaming bị buffer nếu config sai → test sớm, có thể bypass qua Caddy direct cho /chat
- **Postgres connection pool**: Next.js serverless mode pool tốt; nếu deploy node standalone cần pgbouncer khi scale
- **Auth defer risk**: Web public không auth = ai có IP whitelist đều vào. **Bắt buộc** giữ Caddy IP allow list hoặc VPN-only đến khi auth plug xong. KHÔNG mở public domain MVP.
- **TanStack Virtual perf**: với 100k row cần test, fallback pagination
- **shadcn version drift**: pin component versions

## Security
- Mọi BFF route check session, role
- Agent FastAPI verify JWT từ BFF (không trust header user_id)
- CSRF: Auth.js handle
- XSS: react-markdown disable raw HTML, sanitize log content trước render
- Rate limit BFF middleware (per user)
- Audit mọi action mutate (eval trigger, user role change, token gen)

## Next Steps
- Phase 05 eval trigger từ admin page
- Phase 06 Telegram alert có deep link về `/chat/[id]` hoặc `/trace?alert_id=`
- Phase 08 MCP token sinh từ settings
