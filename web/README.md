# onelog web (MVP slice: chat only)

Next.js 14 (App Router) + Tailwind. Single-page chat UI that streams from the agent via SSE.

## Scope (this slice)
- `/chat` — message list, input, SSE stream from `/api/chat`
- BFF `/api/chat` proxies POST → agent `/chat` (server-to-server, no CORS)
- Citation `[svc:host:ts]` → clickable link → opens vmui with LogsQL filter for that stream/window
- Tool call cards (collapsible — show name, input, result)

Deferred to next slice: conversation history (Postgres), `/trace`, `/admin/*`, settings, auth login.

## Run via compose

```bash
cd infra
docker compose --profile web up -d --build web

# Verify
curl http://localhost:3000/chat | head
```

Open in browser: `http://<logserver>/chat` (via Caddy) or `http://localhost:3000/chat` (direct).

## Local dev

```bash
cd web
npm install
AGENT_URL=http://localhost:8080 npm run dev
# open http://localhost:3000
```

## Env

| Var | Default | Notes |
|---|---|---|
| `AGENT_URL` | `http://agent:8080` | Backend agent URL |
| `NODE_ENV` | `production` | |

## File layout

- `src/app/layout.tsx` — root layout + globals.css
- `src/app/page.tsx` — redirect `/` → `/chat`
- `src/app/chat/page.tsx` — server shell
- `src/components/chat/chat-view.tsx` — client UI (state + SSE consume + render)
- `src/lib/sse-client.ts` — POST → SSE parser (manual, since EventSource is GET-only)
- `src/lib/citation.ts` — `[svc:host:ts]` parser + vmui deep-link builder
- `src/app/api/chat/route.ts` — BFF SSE pass-through to agent
- `Dockerfile` — multi-stage standalone build
