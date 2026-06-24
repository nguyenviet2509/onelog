# Phase 04 · Chat page revamp

**Priority:** P0 · **Status:** pending · **Depends on:** Phase 01

## Overview
Restyle chat sang layout 3 cột: sidebar grouped, message panel với header info, right context panel (retrieval + sources + tool calls). Match `mockups/v2/02-bento-minimal.html` section CHAT.

## Layout
```
[sidebar 240px] [chat flex-1] [context panel 280px]
```

### Sidebar — `components/chat/sidebar.tsx` (update existing)
- "+ New chat" button đầy đủ width, white bg, kbd `⌘N`.
- Section grouped: **Pinned** (max 3), **Today**, **Yesterday**, **Earlier**.
- Item hover bg subtle, active bg `#15151a`.
- Group conversations by `created_at` date bucket.

### Chat view — `components/chat/chat-view.tsx` (update existing)
Header row:
- Title h1 (conversation title).
- Meta: `model · {turns} turns · started {time}`.
- Right side: tokens up/down + cost (`$0.04`) — query from `llm_calls` aggregate.

Message bubbles:
- User: right-aligned, `bg-[#15151a]` border line, rounded-2xl rounded-tr-md, max-w 70%.
- Assistant: left, no bubble, plain text.
- Tool call inline: chip with dot + name + latency + hit count (font-mono).
- Cluster cards (3-col grid) for structured results.

Footer composer:
- Card-wrapped textarea + Send button (white bg, black text) + `/` kbd hint.

### Context panel — `components/chat/context-panel.tsx` (new)
Two sections:
1. **Retrieval**: hit rate %, bar, vector p95, rerank toggle state.
2. **Sources**: list font-mono `source:host` + count.

Data source: read from message metadata (`messages.metadata jsonb` — add field if needed).

## Data flow
- Conv list: `GET /api/conversations` (đã có).
- Messages: `GET /api/conversations/{id}/messages` (đã có).
- Header aggregate: thêm join `llm_calls` SUM(tokens, cost) → augment response, hoặc gọi `/api/conversations/{id}/stats` mới.
- Citations: parse `messages.metadata.citations` (giữ schema cũ).

## Acceptance
- [ ] Layout 3 cột responsive ≥ 1280px; mobile collapse sidebar (out of scope chi tiết, dùng `lg:` breakpoint).
- [ ] Tool call render với dot + latency.
- [ ] Header hiển thị tokens + $ từ `llm_calls` aggregate.
- [ ] Context panel show real hit rate (parse metadata) hoặc placeholder nếu null.
- [ ] Visual diff với mock ≤ 10% sai lệch (spacing, color).

## Files
- modify: `web/src/components/chat/sidebar.tsx`, `web/src/components/chat/chat-view.tsx`
- create: `web/src/components/chat/context-panel.tsx`
- modify (if needed): `web/src/app/api/conversations/[id]/messages/route.ts` — include llm_call stats
