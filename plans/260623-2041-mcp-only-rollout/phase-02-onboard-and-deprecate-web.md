# Phase 02 — Onboard ops + deprecate Web/agent

## Context
- Plan: [plan.md](plan.md)
- Phase trước: [phase-01-mcp-production-ready.md](phase-01-mcp-production-ready.md)
- Decision: [brainstorm-260623-1644-ops-mcp-only-decision](../reports/brainstorm-260623-1644-ops-mcp-only-decision.md)

## Overview
- Priority: P0
- Status: pending (blocked by Phase 01)
- Effort: ~1.8 ngày-người (thêm 0.3d cho resurrect drill)
- Mục tiêu: onboard 5 ops dùng MCP từ Claude Desktop, setup Claude Team Project knowledge sharing, decommission Web UI + agent service. Giữ branch `legacy-web` để rollback nếu cần.

## Key insights
- Phase 02 step đầu là **verify subscription type** — Claude.ai Team (có Projects) hay Claude Code Team (chỉ billing). Đây là block: nếu không có Projects, knowledge sharing fail → revisit decision.
- Decommission web/agent: stop container + remove từ prod compose, **không xóa code** ngay. Giữ trong branch `legacy-web` 3-6 tháng phòng phải resurrect.
- Onboarding 5 user = 1 meeting 30 phút chung + paste config + smoke test cùng nhau, không phải 5 session riêng.

## Related files
**Create:**
- `docs/mcp-setup-guide.md` — 1 trang setup Claude Desktop (claude_desktop_config.json, npx mcp-remote, screenshot)
- `docs/onelog-team-project-guide.md` — convention dùng Project `onelog-investigations`, naming conversation, tag

**Modify:**
- `infra/docker-compose.yml` — remove (hoặc comment) services `web` + `agent`
- `infra/.env.example` — remove `ANTHROPIC_API_KEY`, `LLM_MOCK` (server-side không cần)
- `README.md` — update channel mới (MCP-only), bỏ link web UI, thêm Project link

**Delete (sau soak 1 tuần):**
- Không xóa code `web/` `agent/` ngay — giữ branch `legacy-web` checkout từ master trước decommission

## Implementation steps

### Step 1 — Verify subscription type (BLOCKING, 0.1d)
1. Login admin Anthropic workspace
2. Check plan: `Claude.ai Team` (workspace có **Projects** feature) vs `Claude Code Team`
3. Nếu là **Claude.ai Team** → ✅ continue
4. Nếu là **Claude Code Team only** → STOP, escalate user:
   - Option a) Upgrade lên Claude.ai Team
   - Option b) Revert decision, dùng Tier 1 share (Slack channel)
   - Option c) Tier 3 build `search_past_incidents` MCP tool

### Step 2 — Tạo Claude Team Project (0.1d)
1. claude.ai → workspace → Projects → New Project `onelog-investigations`
2. System prompt:
   ```
   Bạn là log investigation assistant cho team ops onelog.

   Quy tắc dùng tool MCP:
   - Câu hỏi fuzzy/intent ("vì sao chậm", "lỗi gì gần đây") → gọi search_log_templates TRƯỚC
   - Câu hỏi precise LogsQL/facets/stats → gọi query / hits / stats_query của mcp-vl
   - Luôn trích citation [service:host:timestamp] với vmui_url clickable

   Naming convention conversation: "[YYYY-MM-DD] <service> - <triệu chứng>"
   Vd: "[2026-06-24] mysql - connection pool exhausted"

   Trước investigation mới, scan các conversation trong Project để check đã có case tương tự chưa.
   ```
3. Invite 5 ops member với role Member
4. Verify: 1 member tạo conversation test → member khác thấy được

### Step 3 — Doc setup MCP (0.3d)
1. Viết `docs/mcp-setup-guide.md`:
   - Prereq: Claude Desktop, Node.js ≥18
   - Lấy Bearer token cá nhân từ admin (1 token/người)
   - Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) hoặc `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):
     ```json
     {
       "mcpServers": {
         "onelog-vl": {
           "command": "npx",
           "args": ["-y", "mcp-remote", "https://app.local/mcp/vl/sse", "--header", "Authorization: Bearer sk-xxx"]
         },
         "onelog-semantic": {
           "command": "npx",
           "args": ["-y", "mcp-remote", "https://app.local/mcp/semantic/sse", "--header", "Authorization: Bearer sk-xxx"]
         }
       }
     }
     ```
   - Restart Claude Desktop (full quit từ system tray)
   - Verify tool list: hỏi "What MCP tools do you have?"
2. Viết `docs/onelog-team-project-guide.md`: naming convention, khi nào dùng Project vs personal chat

### Step 4 — Onboarding meeting (0.3d)
1. Schedule 30 phút meeting 5 ops
2. Agenda:
   - Demo Project `onelog-investigations` + system prompt
   - Mọi người paste config + restart Claude Desktop
   - Smoke test cùng nhau: 1 câu query semantic + 1 câu LogsQL
   - Discipline: investigation = trong Project, không personal chat
3. Output: 5 ops dùng được, có ≥1 conversation thật trong Project

### Step 5 — Decommission Web + agent (0.3d)
1. Branch checkpoint: `git checkout -b legacy-web && git push -u origin legacy-web`
2. Quay về master, edit `infra/docker-compose.yml`:
   - **COMMENT block** service `web` + `agent` (KHÔNG xóa), thêm header:
     ```yaml
     # DECOMMISSIONED YYYY-MM-DD — MCP-only rollout
     # Resurrect: uncomment block + set ANTHROPIC_API_KEY (hoặc OPENAI_API_KEY) trong .env
     # See plans/260623-2041-mcp-only-rollout/phase-03-review-checkpoint.md
     # web: ...
     # agent: ...
     ```
3. `docker compose stop web agent && docker compose rm web agent`
4. Verify port 3000, 8080 free
5. Remove `ANTHROPIC_API_KEY` từ `.env` prod (rotate Anthropic key luôn vì đã expose env file)
6. Cancel Anthropic API billing nếu account riêng cho onelog (verify không impact dịch vụ khác)
7. Update `README.md`: bỏ link `192.168.122.53/chat`, thêm link Project `onelog-investigations`
8. Update Caddyfile: bỏ route `/chat`, `/api/chat`, giữ `/mcp/*` + `/select/vmui/*` cho VMUI
9. **KHÔNG xóa** folder `web/`, `agent/` trên master — code stay intact để dễ revert/cherry-pick
10. **KEEP Postgres tables** `users`, `conversations`, `messages`, `audit_log` — không drop schema. Retention tối thiểu **6 tháng**. Document trong `README.md` section "Decommissioned components". Resurrect = `drizzle migrate` lại nếu DB sạch + tables đã có

### Step 5b — Resurrect drill (BLOCKING, 0.3d, ngày kế tiếp Step 5)
Mục đích: verify branch `legacy-web` THẬT SỰ bootable, không phải "tưởng là chạy được".

1. Tạo VM/sandbox riêng (hoặc local laptop, không phải prod)
2. `git clone <repo> && git checkout legacy-web`
3. Tạo `.env` với mock LLM: `LLM_MOCK=true` (đã có support trong agent code)
4. `docker compose up -d web agent` → đợi healthy
5. Smoke test:
   - `curl http://localhost:3000/chat` → trả HTML chat UI
   - Mở browser, gõ "test" → response mock từ agent
6. Đo **time-to-bootable** (target: <30 phút từ checkout đến mock chat work)
7. Nếu fail (deps stale, image build error, env miss):
   - Document fix trong `legacy-web/RESURRECT-NOTES.md`
   - Pin deps trong `web/package-lock.json`, `agent/requirements.txt` (đảm bảo lockfile committed)
   - Commit fix lên branch `legacy-web` (không merge master)
8. Output: `RESURRECT-NOTES.md` ghi time + steps + known issues, link từ phase-03

### Step 6 — Soak 1 tuần + close phase (0.4d, spread)
1. Daily check audit log: 5 user có call tool không, có error không
2. Daily check Claude Team Project: có conversation mới không
3. End of week 1: count duplicate investigation (member 2 hỏi lại case cũ) — target <2/tuần
4. Nếu duplicate >5/tuần → trigger Tier 3 (build search_past_incidents tool)
5. End of week 2: write retro `plans/reports/retro-260707-mcp-only-rollout.md`

## Todo
- [ ] Verify subscription = Claude.ai Team
- [ ] Tạo Project + invite 5 member + system prompt
- [ ] Doc mcp-setup-guide.md
- [ ] Doc onelog-team-project-guide.md
- [ ] Meeting onboarding 5 ops + smoke test
- [ ] Branch legacy-web checkpoint
- [ ] **Comment block** web/agent trong docker-compose (KHÔNG xóa)
- [ ] Stop + remove web/agent containers
- [ ] **Keep folders** `web/`, `agent/` trên master
- [ ] **Keep Postgres schema** (users/conversations/messages/audit_log), document retention ≥6 tháng
- [ ] Remove ANTHROPIC_API_KEY + rotate
- [ ] Update README + Caddyfile
- [ ] **Resurrect drill**: checkout legacy-web → docker compose up → mock LLM smoke test → RESURRECT-NOTES.md
- [ ] Pin lockfiles (`package-lock.json`, `requirements.txt`) trên branch legacy-web
- [ ] Soak 1 tuần, daily audit check
- [ ] Retro report

## Success criteria
- 5 ops onboarded, có config Claude Desktop, smoke test pass
- Project `onelog-investigations` có ≥10 conversation sau 2 tuần
- Web + agent stopped, port 3000/8080 free
- ANTHROPIC_API_KEY removed + rotated
- README + Caddyfile updated
- Branch `legacy-web` exist trên remote
- Audit log có entry từ ≥4/5 user trong tuần đầu
- Duplicate investigation <5/tuần (target sharing work)

## Risks
- Subscription type không đúng → STOP gate ở step 1, có 3 fallback rõ
- Member nào đó không dùng → manager reach out, không phải tech issue
- Web decommission gây regression nếu có hidden dependency → branch legacy-web rollback trong 5 phút
- Anthropic API key shared với service khác → check trước khi rotate

## Security notes
- ANTHROPIC_API_KEY rotate sau decommission (không chỉ remove env)
- Branch `legacy-web` chứa key cũ trong git history → squash/filter-branch nếu commit có key, hoặc rely on rotate
- Project Claude Team: invite chỉ qua email công ty, không cá nhân
- Audit log retention ≥90 ngày

## Next
- Retro tuần 2 → quyết định giữ MCP-only hay tier-up
- Nếu thành công → archive plan này + plan supersedes
- Phase ngoài plan: nếu cần `search_past_incidents` tool, scope plan mới riêng
