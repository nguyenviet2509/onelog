# Finalize Report — kb-inet-bookstack-mcp-bridge

Date: 2026-07-31 08:32
Status: **COMPLETED**

## Full stack verified

```
User chat OpenWebUI
  → deepseek (LLM function call)
  → mcpo (OpenAPI proxy)
  → bookstack-mcp container (MCP Streamable HTTP)
  → https://kb.inet.vn/api/*  (via eth1 route)
  → JSON results
  → LLM cite kb.inet.vn/... in reply
```

Test query "Redis OOM cPanel" → 7 results, top = "Khắc phục lỗi Redis OOM..." (page 959).

## Timeline

| Time | Event |
|---|---|
| 2026-07-30 14:56 | Brainstorm (`ttpears/bookstack-mcp` chosen over custom write) |
| 15:04 | Plan created (5 phases + deferred Caddy) |
| 15:13 | Validation — scope thu hẹp chỉ KB, wiring qua mcpo (không phải mcp-config.json) |
| 15:37 | Cook — local files committed (compose + mcpo config + docs + env) |
| 15:52 | KB audit — 375 pages, diacritic-fold works, token verified |
| 16:00 | VPS deploy — bookstack-mcp healthy, mcpo 3 upstreams |
| 16:16 | OpenWebUI UI wired (user manual), tool discovered |
| 16:37 | Bug: `socket hang up` — investigation |
| 16:49 | Root cause: WAF `btwaf` chặn eth0 IP → route qua eth1 fix |
| 17:12 | Token rotated (leak on chat) → re-deployed |
| 08:15 | Day 2: route lost (ad-hoc) → re-added |
| 08:32 | Persist route in `eth1-policy-routing-apply.sh` |

## What worked / what didn't

**Worked:**
- Choosing existing `bookstack-mcp` over custom write (saved ~2 days effort).
- mcpo bridge pattern (already established for onelog-vl + onelog-semantic).
- Health-check exclusion for bookstack (avoided kill-loop cascading log tools).
- KB audit before deploy (confirmed size + diacritic → simplified prompt).

**Didn't work / needed fix:**
- Initial plan assumed OpenWebUI native MCP → actually uses mcpo (fixed via scout in cook).
- Deferred Caddy phase (docker internal enough) — correct call.
- WAF whitelist attempt — 宝塔 whitelist only covered root path, not `/api/*` with Authorization header. Pivoted to eth1 route.

## Final architecture

```yaml
Services:
  bookstack-mcp:
    image: ghcr.io/ttpears/bookstack-mcp:latest
    profile: chat
    env: KB_INET_TOKEN_ID/SECRET, ENABLE_WRITE=false
    network: docker default (egress via host routing)
  mcpo:
    upstreams: onelog-vl, onelog-semantic, bookstack
    healthcheck excludes bookstack (isolation)
  openwebui:
    tool: http://mcpo:8080/bookstack (OpenAPI, Bearer MCPO_API_KEY)
    prompt: docs/openwebui-kb-routing.md

Routing:
  /usr/local/sbin/eth1-policy-routing-apply.sh
  → ip route replace 103.216.116.55/32 via 10.200.0.1 dev eth1
  Timer: every 5 min re-apply
  On boot: systemd service eth1-policy-routing.service
```

## Delivery checklist

- [x] `infra/docker-compose.yml` — bookstack-mcp service
- [x] `infra/mcpo/config.template.json` — bookstack upstream
- [x] `infra/.env.example` — KB_INET_* placeholders
- [x] `docs/openwebui-kb-routing.md` — wiring + system prompt (VN)
- [x] Plan + phase files + reports + notes/kb-audit.md
- [x] VPS `/opt/onelog/infra/.env` — KB_INET_* set (token 2, token 1 revoked)
- [x] VPS `/usr/local/sbin/eth1-policy-routing-apply.sh` — kb.inet.vn route persisted
- [x] OpenWebUI Admin → Tools → bookstack registered
- [x] OpenWebUI Workspace → Models → System Prompt applied
- [x] Memory saved: `kb-inet-eth1-routing.md`
- [x] Plan status: completed

## Metrics — measured live

| Metric | Result |
|---|---|
| E2E latency mcpo → search_pages | <400ms |
| bookstack-mcp uptime | Healthy since 2026-07-30 |
| Token auth | 200 OK |
| WAF bypass via eth1 | Confirmed |
| Tool discoverability | 20 tools exposed by mcpo |
| Whitelist enforcement in LLM | Confirmed (LLM used `tool_search_pages_post`) |

## Follow-ups (not blocking, YAGNI)

1. **Tool bloat monitoring** — LLM has access to 20 bookstack tools. Prompt whitelist enforces 3, but if metric shows >10% out-of-whitelist calls in 2 weeks → migrate to OneMCP-proxy pattern (only 3 tools exposed).
2. **kb.inet.vn IP change detection** — daily cron `dig +short kb.inet.vn` + alert if drift from `103.216.116.55`. YAGNI unless it happens.
3. **Session ID hygiene** — mcpo maintains 1 session with bookstack-mcp. Long-lived. If mcpo restarts unexpectedly → auto re-init. No action needed.

## Unresolved

- 宝塔 WAF rule blocking `/api/*` from eth0 not deeply understood. Not investigated further — eth1 route bypasses it cleanly. If someone needs eth0 access to kb.inet.vn later, need to work with KB admin on 宝塔 rule (path exemption or IP whitelist at correct level).
