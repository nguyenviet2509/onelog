# Brainstorm Report — Re-scope: Web UI primary + MCP server (Phase 08)

- Date: 2026-06-22 11:13
- Status: Design approved by user
- Consolidates: 2 thay đổi sau brainstorm gốc `brainstorm-260622-1056-rag-logserver-victorialogs.md`
- Updates plan: `plans/260622-1056-rag-logserver-victorialogs/`

---

## 1. Problem statement

Sau brainstorm gốc, user re-scope 2 lần:
1. Telegram Q&A → **Web UI Next.js primary** (Telegram giữ minimal cho alert push)
2. Bổ sung **MCP server** Phase 08 (sau MVP) để sysadmin truy log từ Claude Code/Desktop

Mục tiêu: hệ thống RAG log có Web UI deep trace + admin panel, sau cho phép IDE assistant truy log qua MCP.

## 2. Decisions chốt (consolidated)

### 2.1 Web UI
| Mục | Quyết định |
|---|---|
| Stack | Next.js 15 App Router + TypeScript + shadcn/ui + Tailwind |
| Auth | Auth.js v5 OIDC (Authentik/Keycloak/Google) |
| DB mới | Postgres 16 + Drizzle ORM (conversations, audit, users, eval) |
| Stream | SSE từ FastAPI agent |
| Hosting | Cùng VM single-node, Caddy reverse proxy + TLS LE |
| Sysadmin context | Chủ yếu desktop (công ty) |
| Telegram | Giữ chỉ cho alert push (one-way, không Q&A) |

### 2.2 MCP server (Phase 08, sau MVP)
| Mục | Quyết định |
|---|---|
| Scenario | A — expose tools agent qua MCP server, IDE consume |
| Stack | FastMCP (Python), share module tool với agent FastAPI |
| Transport | SSE (HTTP) + stdio |
| Auth | API token per-user, sinh từ Web /settings, lưu Postgres |
| Timing | Phase 08 sau MVP, ~1-2 ngày |
| Use frequency | Thỉnh thoảng (không phải primary UX) |

## 3. Architecture cuối

```
Sysadmin
   ├── Browser → [Caddy TLS] → [Next.js Web] ──┐
   │                                            │
   ├── Claude Code/Desktop → MCP SSE/stdio ────┤
   │                                            ▼
   │                                    [Agent FastAPI]
   │                                    /chat (SSE)
   │                                    /trace, /admin
   │                                    /mcp (FastMCP)
   │                                            │
   │                                ┌───────────┼───────────┐
   │                                ▼           ▼           ▼
   │                          [Postgres]   [Qdrant]   [VictoriaLogs]
   │                          users/conv/                     ▲
   │                          audit/eval                      │
   │                                                    [Vector.dev]
   │                                                          ▲
   │                                                          │
   └── Telegram (alert only) ◄── [Bot] ◄── [Alertmanager] ◄── [vmalert]
```

## 4. Plan changes (apply vào `260622-1056-rag-logserver-victorialogs/`)

| Phase | Change |
|---|---|
| 01 Infrastructure | +Postgres 16 service, +Caddy service vào docker-compose, +TLS config |
| 02 Indexer | Không đổi |
| 03 Agent service | +OIDC JWT verify middleware, +Postgres persistence cho conversation/audit, +/admin endpoints, +/trace passthrough endpoint |
| 04 **REWRITE** Telegram bot → **Web app Next.js** | Hoàn toàn rewrite: chat page, trace page, admin page, settings, Auth.js OIDC |
| 05 Eval harness | +UI trigger từ /admin/eval, results lưu Postgres |
| 06 Alertmanager | Telegram bot **minimal one-way** (~100 LOC), không message handler |
| 07 HA roadmap | +Web stateless scale, +Postgres replica plan |
| **08 NEW** MCP server | FastMCP wrap tools, API token auth, deploy cùng compose |

## 5. Postgres schema (mới)

```sql
users(id, email, name, role, oidc_sub, created_at)
conversations(id, user_id, title, created_at, updated_at)
messages(id, conversation_id, role, content_md, tool_calls_json, tokens_in, tokens_out, cost_usd, citations_json, created_at)
audit_log(id, user_id, source ENUM('web','mcp','alert'), action, target, metadata_json, created_at)
eval_runs(id, prompt_version, started_at, finished_at, pass_rate, p95_latency_ms, total_cost_usd)
eval_results(id, run_id, case_id, score, citation_valid, latency_ms, cost_usd, response_md)
api_tokens(id, user_id, token_hash, name, scope, expires_at, revoked_at, created_at)  -- for MCP
```

## 6. Web app feature breakdown

### 6.1 /chat — Q&A chính
- ChatGPT-like UI, sidebar lịch sử conversation persistent (Postgres)
- SSE streaming, markdown + syntax highlight
- Inline citation `[postfix:mail-01:10:25:30]` → click mở panel raw log
- Tool call visible collapsible
- Share link permalink

### 6.2 /trace — Deep log explorer
- Filter sidebar: service/host/severity/time range
- Log table virtualized (TanStack Table), follow tail mode
- Histogram count over time, click drill window
- "Ask AI about this view" → mở chat với context filter pre-filled
- Advanced LogsQL editor

### 6.3 /admin (role=admin)
- Audit log table (filter user/source web/mcp/alert/time)
- Cost dashboard USD/ngày, breakdown user/tool/model
- Eval runs list, trigger new run, regression chart
- User management CRUD + role
- System health VL/Qdrant/agent
- API token management (cho MCP)

### 6.4 /settings
- Profile, theme
- "Generate MCP token" → tạo token + config snippet Claude Desktop/Code

## 7. MCP server (Phase 08)

- Wrap 4 tool: `search_log_templates`, `query_victorialogs`, `summarize_window`, `list_services_hosts`
- Module share `agent/src/agent/tools/*.py` (DRY)
- Auth Bearer token verify qua Postgres `api_tokens` table (hash compare)
- Redaction + audit log giống Web path
- Config snippet generated từ Web cho user paste vào Claude Desktop/Code

## 8. Effort estimate (re-scoped MVP)

| Phase | Effort |
|---|---|
| 01 Infra (+Postgres+Caddy) | 2-3 ngày |
| 02 Indexer | 4-5 ngày |
| 03 Agent (+OIDC+Postgres+endpoints) | 6-8 ngày |
| 04 Web app Next.js (chat+trace+admin) | 10-14 ngày |
| 05 Eval (+UI trigger) | 4-5 ngày |
| 06 Alertmanager + Telegram alert minimal | 2-3 ngày |
| 07 HA doc | 1 ngày |
| **MVP total** | **~5-6 tuần** |
| 08 MCP server | +1-2 ngày sau MVP |

## 9. Risks mới

- **Auth infra dependency**: cần IdP sẵn (Authentik/Keycloak/Google Workspace)
- **Frontend skill gap**: Next.js cần kinh nghiệm; team Python-only → cân nhắc FastAPI+HTMX (downside: ít linh hoạt)
- **Postgres SPOF**: thêm service cần snapshot
- **TLS cert**: Caddy auto, cần DNS đúng
- **MCP spec evolve**: pin version, monitor changelog
- **MCP token leak**: revoke nhanh từ admin, scope readonly

## 10. Success criteria (consolidated)

- Web app uptime ≥ 99%
- Chat p95 latency < 8s (1-turn), < 15s (multi-turn)
- Trace page load < 2s với 10k log lines
- Recall RCA ≥ 80% (Phase 05 eval)
- Hallucination rate < 2%
- MCP server (Phase 08): tool call work từ Claude Desktop/Code, latency < 5s
- Cost LLM < $200/tháng MVP

## 11. Unresolved questions (carry forward)

1. Công ty đã có IdP chưa? (quyết định Authentik tự host hay Google Workspace)
2. Postgres managed hay self-host cùng VM?
3. Trace "live tail" mode có cần WebSocket bổ sung không?
4. Eval UI trigger sync hay async (queue)?
5. Domain public hay internal-only?
6. MCP token scope: chỉ readonly hay có write (vd ack alert)?
