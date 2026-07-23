# Brainstorm — Bridge OneMCP → OpenWebUI (thay thế mcp-kb plan)

**Date:** 2026-07-23 12:00 (Asia/Saigon)
**Owner:** trihd@inet.vn
**Status:** Approved — proceed to plan
**Supersedes:** `plans/260723-1135-mcp-kb-incident-memory` (cancel)

## Discovery
Đọc `D:\Vietnt\Project\onemcp` phát hiện OneMCP **đã build đúng bài toán này**. Primary use case OneMCP (README): *"Dev A fix bug → agent submit KB via MCP → Dev B tuần sau paste error → MCP search → hit KB → apply fix trong phút."* Cùng team Kỹ thuật, cùng dept, user có toàn quyền đóng góp.

## Overlap OneMCP ↔ mcp-kb plan cũ
| Feature plan cũ định build | OneMCP đã có |
|---|---|
| MCP tool search/save | ✅ `search` + `submit_artifact` |
| Draft/verified workflow | ✅ Review pending→published |
| Curation UI | ✅ Portal Next.js browse/edit/review |
| Audit + metrics + backup | ✅ Prometheus + audit + daily backup |
| Postmortem/runbook | ✅ Cả 2 types (P7) |
| Alertmanager integration | ✅ P7 webhook |
| RBAC + multi-tenant | ✅ 5 roles |

→ Build mcp-kb riêng = duplicate massive, vi phạm DRY. **Cancel**.

## Gap OneMCP thiếu
- **Semantic search chưa có** (chỉ FTS unaccent + trigram) — P4.2 pgvector còn trong roadmap
- Client mặc định = Claude Code CLI, không phải OpenWebUI
- Auto-submit hook chỉ chạy trên Claude Code (PreCompact)
- Auth model khác (`X-Onemcp-User` trust header + CIDR)

## Recommendation — Option A: Bridge OneMCP vào OpenWebUI
Chấp nhận FTS + trigram của OneMCP làm layer đầu tiên. Escalate lên semantic (Option B — contribute P4.2 pgvector) chỉ nếu empirical MISS rate cao sau 2-4 tuần dùng thật.

### Architecture
```
                 (mới)
OpenWebUI ─▶ mcpo ─▶ onemcp adapter ─▶ OneMCP (:443/api/mcp) ─▶ Postgres + MinIO
              │                            (existing infra)
              ├─▶ mcp-vl       (existing)
              └─▶ mcp-semantic (existing)

OneLog Alertmanager ──webhook──▶ OneMCP /api/webhooks/alerts (existing P7)
```

### Bridge concerns
1. **mcpo transport**: mcpo hiện config JSON-RPC 2.0 MCP servers qua HTTP. OneMCP đúng chuẩn JSON-RPC 2.0 (`POST /api/mcp`). Thêm entry `onemcp` vào `infra/mcpo/config.template.json` với custom header `X-Onemcp-User: openwebui-bot` (hoặc per-user nếu OpenWebUI truyền identity).
2. **Auth**: OneMCP dùng trust header (không Bearer). mcpo cho phép custom headers. Verify onemcp CIDR gate cho phép request từ mcpo container IP (host của OneLog stack).
3. **Network**: verify `onemcp.local` (hoặc IP) reachable từ Docker network của OneLog. Nếu OneMCP ở host khác → cần route/DNS. Nếu cùng host → docker network shared hoặc IP host.
4. **User identity**: option đơn giản — 1 bot user cho tất cả OpenWebUI requests (đủ MVP). Option nâng cao — mcpo/OpenWebUI truyền user login → mcpo inject vào X-Onemcp-User (cần OpenWebUI expose user context vào tool call).
5. **Ổn định**: nếu OneMCP down → OpenWebUI chat vẫn hoạt động (mcpo tool call fail gracefully, LLM tự fallback qua mcp-vl/semantic). Không blocking.

### Workflow trong OpenWebUI
1. System prompt cứng: `search onemcp.search TRƯỚC cho mọi câu hỏi lỗi/incident`
2. LLM gọi `onemcp.search(q)` → nếu hit published entry → present + hỏi "còn đúng không?"
3. Nếu hit pending → present dưới dạng candidate + link portal
4. Miss / user No → chạy full flow (mcp-vl + mcp-semantic)
5. User báo "fixed" → LLM gọi `onemcp.submit_artifact(type=kb, ...)` với question/resolution/tags
6. Team member vào OneMCP portal review + publish

### FTS-first risk & fallback plan
- Save: "nginx 502 upstream timeout php-fpm"
- Query: "gateway lỗi khi request lâu" → FTS MISS (0 shared keyword)
- **Mitigate**:
  - Tags mandatory (dept convention: nginx, php-fpm, timeout...)
  - LLM khi gọi search sinh nhiều query candidate (broaden keywords)
  - Đo `search_miss_then_full_flow` rate trong 2 tuần → nếu > 40% → escalate Option B (contribute pgvector P4.2)

## Success metrics
- Bridge live: OpenWebUI list được onemcp tools trong `/openapi.json` mcpo
- Sau 2 tuần: ≥ 5 chat sessions gọi `onemcp.search` với hit ≥ 1
- Sau 4 tuần: ≥ 10 published KB entries (từ chat submit + verify manual)
- FTS hit rate ≥ 40% (nếu thấp hơn → trigger Option B decision)

## Out of scope
- pgvector semantic (Option B — defer, quyết sau data thực tế)
- OpenWebUI Function auto-submit không qua LLM tool call (chỉ dùng system prompt)
- Migration data từ plan cũ (chưa có gì để migrate)
- OneMCP schema changes (v1 frozen, chỉ add nếu thật cần)

## Cancellation of old plan
Plan `260723-1135-mcp-kb-incident-memory` → status `cancelled-2026-07-23`, reason: superseded by OneMCP reuse. Frontmatter update: `supersededBy: plans/260723-1200-onemcp-openwebui-bridge`.

## Phase sketch cho plan mới
1. **Network + auth prep**: verify OneMCP reachable từ OneLog stack; tạo bot user + role trong OneMCP; CIDR whitelist mcpo IP (1 ngày)
2. **mcpo config**: add onemcp entry + custom headers; healthcheck update; test tool discovery (0.5 ngày)
3. **OpenWebUI system prompt**: viết prompt ép search-first + auto-submit; commit vào `infra/openwebui/system-prompt-ops.md`; admin paste (0.5 ngày)
4. **Alertmanager webhook**: verify OneLog Alertmanager gọi được OneMCP `/api/webhooks/alerts` (0.5 ngày)
5. **Smoke + docs**: end-to-end test (save 3 entries, query trùng, verify hit), docs update README + deployment guide (1 ngày)

**Tổng: 2-4 ngày** vs 1-2 tuần plan cũ.

## Unresolved
- OneMCP đang deploy ở đâu (host, URL, DNS)? Cần info để cấu hình mcpo.
- OpenWebUI có API/config truyền user login vào MCP tool headers không? Nếu không → dùng bot user chung.
- OneMCP CIDR gate hiện allow những gì? Cần whitelist host chạy OneLog stack.
- Có nên chuyển các postmortem/runbook OneLog hiện có (nếu có) vào OneMCP luôn để test?
- Đóng góp P4.2 pgvector: nếu quyết Option B sau này, ai lead? (OneLog team hay OneMCP team?)
