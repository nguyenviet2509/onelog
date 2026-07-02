# Phase 05 — Docs Sync + Team Migration

## Context
- Brainstorm: [../reports/brainstorm-260701-1544-llm-provider-abstraction.md](../reports/brainstorm-260701-1544-llm-provider-abstraction.md)
- Depends: Phase 3 (OpenWebUI chạy) + Phase 4 (benchmark done)
- Existing docs: [docs/mcp-setup-guide.md](../../docs/mcp-setup-guide.md), [docs/deployment-guide.md](../../docs/deployment-guide.md), [docs/onelog-team-project-guide.md](../../docs/onelog-team-project-guide.md)

## Overview
- **Priority:** Medium
- **Status:** pending
- **Description:** Sync docs với architecture mới. Chuyển team ops khỏi Claude Desktop sang OpenWebUI trong 2 tuần. Giữ Claude Desktop path làm appendix (BC).

## Key insights
- Docs = last-mile của technical work. Nếu team không migrate, coi như chưa xong.
- Cần giữ Claude Desktop appendix để tránh force migration; disable path này ở release sau.
- Docs mới phải cover: login, model picker, MCP tool usage, cost visibility.

## Requirements

### Functional
- `mcp-setup-guide.md` — section chính = OpenWebUI, Claude Desktop = appendix.
- `deployment-guide.md` — ops steps cho LiteLLM + OpenWebUI (backup, restart, key rotation).
- `onelog-team-project-guide.md` — daily workflow qua OpenWebUI (thay Claude project).
- `openwebui-user-guide.md` (mới, Phase 3 đã stub) — hướng dẫn end-user.
- Migration plan cụ thể ngày (cutover date, buddy assignment).

### Non-functional
- Tất cả docs VI (audience 5 ops VN).
- Screenshots UI OpenWebUI (chụp lại sau khi Phase 3 stable).

## Related code files

### Modify
- `docs/mcp-setup-guide.md` — restructure
- `docs/deployment-guide.md` — thêm section LLM stack
- `docs/onelog-team-project-guide.md` — update daily workflow
- `README.md` (nếu có, root) — update quick start

### Create
- `docs/openwebui-user-guide.md` — end-user guide (chi tiết hơn stub Phase 3)
- `docs/llm-provider-ops.md` — admin guide (rotate keys, adjust budget, add provider)
- **`docs/deployment-llm-abstraction.md`** — hướng dẫn deploy pull code + chạy stack LLM lên logserver (style match `deployment-guide.md`)
- `plans/260701-1544-llm-provider-abstraction/migration-plan.md` — cutover cụ thể

### Delete
- Không có (giữ Claude Desktop path appendix).

## Implementation steps

### Step 1 — Restructure `mcp-setup-guide.md`
Structure mới:
```
1. Overview
2. Setup OpenWebUI (main path)
   2.1. Đăng ký tài khoản
   2.2. Chọn model
   2.3. Verify MCP tools
   2.4. Chat mẫu
3. Troubleshooting
4. Appendix A — Claude Desktop (legacy)
   [nội dung hiện tại giữ nguyên]
5. Appendix B — Cursor / Continue.dev (optional)
```

### Step 2 — Update `deployment-guide.md` (short reference)
Thêm section trỏ sang file deploy chi tiết:
```
## LLM Stack (added by plan 260701-1544)

Xem chi tiết: [deployment-llm-abstraction.md](deployment-llm-abstraction.md).

### Quick reference
- Restart: `docker compose --profile chat --profile llm restart`
- Backup OpenWebUI: `/opt/onelog/infra/scripts/backup-openwebui.sh`
- Key rotation: xem `llm-provider-ops.md`
- Cost check: `curl /llm/spend/logs -H "Authorization: Bearer $MASTER_KEY"`
```

### Step 2b — Viết `deployment-llm-abstraction.md` (deliverable chính)
File hướng dẫn deploy phần LLM stack lên `logserver` (192.168.122.53). **Bắt buộc**
style match `deployment-guide.md`: Vietnamese, checklist, troubleshooting table, smoke test theo thứ tự.

Cấu trúc bắt buộc:

```markdown
# Deployment Guide — LLM Provider Abstraction (Plan 260701-1544)

> Deploy litellm-proxy + openwebui + agent LiteLLM adapter lên `logserver`.
> Prerequisite: đã cook xong Phase 1-4 (code merge master), stack hiện tại đang chạy.

## 1. Topology (delta so với deployment-guide.md)
[ASCII diagram nhỏ: thêm 2 container litellm-proxy + openwebui vào stack có sẵn]

## 2. Pre-requisites
- Đã có deploy hiện tại chạy OK (theo deployment-guide.md)
- 4 API keys sẵn sàng: Anthropic, OpenAI, Gemini, DeepSeek (có ít nhất 1)
- Có sẵn `LITELLM_MASTER_KEY` random (sinh bằng `openssl rand -hex 32`)

## 3. Pull code + update .env
```bash
cd /opt/onelog
git fetch origin
git status                              # đảm bảo không có local change
git pull origin master
git log --oneline -5                    # verify commit LLM abstraction đã có
```

### 3.1 Merge .env
```bash
cd /opt/onelog/infra
diff .env.example .env | less           # xem biến mới cần thêm
```
Thêm vào `.env`:
```env
# --- LLM Provider Abstraction (plan 260701-1544) ---
LLM_MODEL=gemini/gemini-2.5-flash
LLM_MAX_TOKENS=4096
LLM_FALLBACK_MODELS=openai/gpt-4.1-mini,anthropic/claude-sonnet-4-5

OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
DEEPSEEK_API_KEY=...

# LiteLLM proxy
LITELLM_MASTER_KEY=sk-litellm-<32-char-random>
LITELLM_DATABASE_URL=

# OpenWebUI
OPENWEBUI_SECRET_KEY=<32-char-random>
OPENWEBUI_LITELLM_VIRTUAL_KEY=          # để trống ban đầu, tạo sau Step 5
MCP_BEARER_INTERNAL=<token-internal>
```

## 4. Deploy stack
```bash
cd /opt/onelog/infra
docker compose pull litellm-proxy openwebui
docker compose --profile llm up -d litellm-proxy
docker compose ps litellm-proxy         # chờ healthy ~30s

# Verify LiteLLM up
curl -fsS http://localhost:4000/health/liveliness

# Verify 4 model alias
curl -fsS http://localhost:4000/v1/models \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" | jq '.data[].id'

# Chỉ up OpenWebUI sau khi LiteLLM healthy
docker compose --profile chat up -d openwebui
docker compose ps openwebui             # chờ healthy ~1 phút (first-run migrate DB)
```

## 5. Tạo virtual key cho OpenWebUI
```bash
curl -X POST http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"models":["gemini-flash","gpt-4-mini","claude-sonnet","deepseek"],
       "max_budget":100,"budget_duration":"30d","key_alias":"openwebui"}' | jq .

# Copy key `sk-...` trả về, paste vào .env → OPENWEBUI_LITELLM_VIRTUAL_KEY
# Rồi restart openwebui
docker compose restart openwebui
```

## 6. Update agent service (LiteLLM adapter)
Agent tự dùng LiteLLM trực tiếp (không qua proxy trong slice đầu). Chỉ cần rebuild:
```bash
docker compose build agent
docker compose up -d agent
docker compose logs -f --tail=50 agent  # verify không còn "anthropic.messages.create" trong startup
```

## 7. Smoke test (theo thứ tự)

### 7.1 LiteLLM proxy trực tiếp
```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-flash","messages":[{"role":"user","content":"hello VN"}]}' \
  | jq '.choices[0].message.content'
```
Kỳ vọng: response VI hoặc EN, HTTP 200.

### 7.2 Fallback chain
Tạm rename `GEMINI_API_KEY` trong .env thành `_GEMINI_API_KEY`, restart:
```bash
docker compose restart litellm-proxy
# Gọi lại request gemini-flash → phải auto route sang gpt-4-mini, response 200 kèm log fallback
docker compose logs litellm-proxy | jq 'select(.event=="fallback_triggered")'
```
Khôi phục key sau khi verify.

### 7.3 Agent /chat với LiteLLM
```bash
curl -N -X POST http://192.168.122.53/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"query":"mysql có lỗi gì gần đây?"}' \
  | grep -E '^event:|^data:' | head -30
```
Kỳ vọng SSE events `thinking`, `tool_call`, `tool_result`, `answer` như trước — parity với Anthropic baseline.

### 7.4 OpenWebUI qua Caddy
Mở browser: `https://192.168.122.53/webui/` → đăng ký admin account.
- Verify model picker có 4 alias.
- Verify MCP panel show 13 tool (11 từ mcp-vl + 1 semantic + 1 nội bộ nếu có).
- Chat mẫu: "Dùng search_log_templates tìm log mysql" → verify tool call + citation.

### 7.5 Cost tracking
Sau vài query, check:
```bash
curl -fsS http://localhost:4000/spend/logs \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" | jq '.[] | {model, spend, timestamp}'
```

## 8. Verification checklist

- [ ] `git pull` thành công, có commit LiteLLM abstraction
- [ ] `.env` có đủ 8 biến mới, giá trị hợp lệ
- [ ] `docker compose ps litellm-proxy openwebui` → cả 2 healthy
- [ ] `curl /v1/models` list 4 model alias
- [ ] Fallback chain verify OK
- [ ] Agent `/chat` SSE stream trả answer với citation
- [ ] OpenWebUI login được, MCP tools load
- [ ] Cost log có record sau smoke test
- [ ] Backup cron `backup-openwebui.sh` chạy dry-run OK
- [ ] `systemctl status ragstack` vẫn healthy (thêm 2 container không phá compose profile)

## 9. Troubleshooting

| Triệu chứng | Check | Fix |
|---|---|---|
| `litellm-proxy` restart loop, log `pydantic ValidationError config.yaml` | Config YAML sai schema | Verify `provider/model` format đúng; check LiteLLM version bump breaking change |
| `curl /v1/models` → 401 | Master key sai / chưa export | `export LITELLM_MASTER_KEY=$(grep LITELLM_MASTER_KEY .env | cut -d= -f2)` |
| `curl /v1/models` → 500 provider unreachable | Egress proxy chặn OpenAI/Gemini | Set `HTTPS_PROXY` trong compose env của litellm-proxy |
| OpenWebUI login fail "Failed to connect to backend" | `OPENAI_API_BASE_URL` sai / LiteLLM chưa up | Verify container name `litellm-proxy` resolve trong docker network |
| OpenWebUI model list empty | Virtual key không có model permission | Regen key với `"models":[...]` đầy đủ |
| OpenWebUI MCP tools không hiện | `mcp-config.json` mount fail / MCP bearer token sai | `docker exec openwebui cat /app/backend/data/mcp-config.json`; check token khớp `MCP_BEARER_INTERNAL` |
| Agent SSE trả `LLM error: BadRequestError` | Message shape adapter miss edge case | Xem log agent, có thể là tool_result content không phải string — báo bug Phase 1 |
| Caddy 502 khi vào `/webui/` | OpenWebUI chưa healthy / handle_path miss | `docker compose logs openwebui`; verify Caddyfile có `handle_path /webui*` |
| Cost tracking trống | `LITELLM_DATABASE_URL` không set → chỉ log stdout | Optional: nếu cần Postgres backend, tạo DB `litellm` trong postgres container + set URL |
| Provider trả `429 rate limit` liên tục | Vượt quota provider | LiteLLM tự retry + fallback; nếu vẫn fail → tăng budget provider hoặc chuyển default model |

## 10. Rollback

Nếu smoke test fail và cần rollback:
```bash
cd /opt/onelog
git log --oneline -10                   # tìm commit trước LiteLLM
git checkout <sha-before-llm-plan>      # detach HEAD
docker compose --profile chat --profile llm down
docker compose build agent
docker compose up -d agent
# stack quay về Anthropic direct, Claude Desktop path vẫn nguyên
```

Hoặc partial rollback (giữ proxy, agent về Anthropic):
```bash
# .env
LLM_MODEL=anthropic/claude-sonnet-4-5   # force agent về Claude
docker compose restart agent
```

## 11. Post-deploy tasks

- [ ] Update `/etc/onelog-ragstack.env` nếu systemd unit cần profile mới:
  `COMPOSE_PROFILES=agent,mcp,chat,llm`
- [ ] Reboot logserver test → verify openwebui + litellm-proxy tự up
- [ ] Add backup-openwebui cron: `0 3 * * * /opt/onelog/infra/scripts/backup-openwebui.sh`
- [ ] Snapshot script (`snapshot-daily.sh`) update include openwebui volume nếu cần

## 12. Unresolved questions

1. Cost tracking Postgres backend có cần enable ngay không, hay để stdout JSON tail vào VictoriaLogs?
2. Systemd unit `ragstack.service` COMPOSE_PROFILES đã nên include `llm,chat` chưa, hay để manual up?
3. OpenWebUI volume có nên add vào snapshot-daily.sh không (chat history size ước tính ~100MB/tháng)?
```

**Yêu cầu implementation:** file này phải tự chứa đủ để 1 ops engineer khác có thể pull code + deploy mà không cần đọc plan gốc. Copy-paste command block phải chạy được ngay.

### Step 3 — Update `onelog-team-project-guide.md`
Thay section "Khi nào tạo conversation trong Project onelog-investigations" bằng "Khi nào tạo folder trong OpenWebUI workspace":
```
- OpenWebUI có tính năng workspace/folder → dùng thay Claude Project
- Naming convention giữ nguyên: {YYYY-MM-DD}-{service}-{issue}
- Share chat: click Share → gửi link cho teammate
```

### Step 4 — Viết `openwebui-user-guide.md`
Nội dung (VI):
- Đăng ký (admin invite)
- UI overview: sidebar, model picker, MCP tools indicator
- Chọn model theo tình huống (khi nào dùng Claude vs Gemini)
- Sử dụng MCP tools (search_log_templates, query LogsQL)
- Share conversation
- Naming convention & organization
- Keyboard shortcuts

### Step 5 — Viết `llm-provider-ops.md`
Admin guide:
- Cấu trúc container (litellm + openwebui)
- Rotate provider API key
- Thêm provider mới
- Adjust budget virtual keys
- Xem cost breakdown
- Troubleshoot: fallback không trigger, model list empty, MCP tool timeout
- **[RT-F9] Kill-switch runtime** — disable 1 provider ngay không cần restart:
  ```bash
  # Disable Gemini nếu key leak — runtime, no downtime
  curl -X POST http://localhost:4000/model/delete \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
    -d '{"model_name":"gemini-flash"}'

  # Sau khi rotate key, re-add:
  curl -X POST http://localhost:4000/model/new \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
    -d '{"model_name":"gemini-flash","litellm_params":{...}}'
  ```
  **Fallback chain tự route sang provider còn lại — verify bằng smoke test trước khi trust.**

- **[RT-F11] Postgres schema isolation** — LiteLLM ở schema `litellm` riêng, không phải `public`:
  ```sql
  CREATE SCHEMA litellm;
  -- LiteLLM tự CREATE TABLE trong schema này qua search_path
  ```
  Rollback triệt để:
  ```sql
  DROP SCHEMA litellm CASCADE;  -- xóa toàn bộ LiteLLM tables, không ảnh hưởng rag-agent
  ```

### Step 6 — Migration plan (`migration-plan.md`)
> **[RT-F15]** Governance rule cứng — tránh slip vô định nếu team không migrate đủ.

```
| Date | Milestone | Threshold | Action nếu miss |
|---|---|---|---|
| D-7 | Phase 1-3 deploy prod. Admin dry-run | Stack healthy | Block cutover |
| D-3 | Onboard 1 ops (early adopter) | 1 người login OK | Fix blocker, delay 1-2 ngày |
| D-1 | Team notification, gửi link + credentials | 5 credentials cấp | Không cutover |
| D+0 | Team meeting 30ph — demo, Q&A | 5/5 attend | Reschedule, không skip |
| D+7 | Check usage OpenWebUI | ≥ 3/5 active | 1-1 onboarding người chưa |
| D+14 | Revoke Claude Desktop MCP tokens | ≥ 4/5 active | **Extend đến D+21, KHÔNG delay vô hạn** |
| D+21 | Second checkpoint revoke | ≥ 4/5 active | **Escalate team lead**, không tự động delay tiếp |
| D+30 | Post-mortem: cost saving thực tế vs prediction | Data đủ | Vẫn viết post-mortem với data có |
```

### Step 7 — Screenshots
Chụp 8-10 screenshot OpenWebUI, lưu `docs/images/openwebui/`, embed vào user guide.

## Todo list
- [x] Restructure `mcp-setup-guide.md` với OpenWebUI làm main
- [x] Update `deployment-guide.md` với LLM stack section (trỏ sang file mới)
- [x] **Viết `deployment-llm-abstraction.md`** — copy-paste-runnable
- [x] Update `onelog-team-project-guide.md` daily workflow
- [x] Viết `openwebui-user-guide.md` (screenshots deferred)
- [x] Viết `llm-provider-ops.md` cho admin
- [x] Viết `migration-plan.md` với timeline
- [ ] Chụp 8-10 screenshot OpenWebUI (defer — cần live UI với real data)
- [ ] Gửi thông báo team migration D-3 (defer — cần Phase 4 xong + keys)
- [ ] Meeting demo D+0 (defer)
- [ ] Kiểm tra usage D+7, follow-up ai chưa migrate (defer)
- [ ] Revoke Claude Desktop bearer tokens D+14 (defer)
- [ ] Viết post-mortem D+30 cost saving (defer)

## Success criteria
- 5/5 ops migrate xong trong 14 ngày sau cutover.
- Không có blocker docs (không ai hỏi câu đã có trong guide).
- Post-mortem D+30: cost saving thực tế ≥ 60% baseline Claude.
- Zero incident trong migration (không ai mất chat history, không ai mất access).

## Risk assessment

| Rủi ro | Mitigation |
|---|---|
| Team resist đổi UX quen thuộc | Giữ Claude Desktop appendix ít nhất 1 tháng; 1-1 onboarding cho ai vướng |
| Docs stale sau vài release | Add checklist trong PR template: "cập nhật docs?" |
| Screenshots outdated khi OpenWebUI update UI | Chụp lại mỗi khi bump major version; commit .png cùng docs change |
| Ops team không đọc docs → hỗ trợ 1-1 nhiều | Meeting 30ph demo + record video, upload link vào docs |

## Security
- Docs không log token/credential thật, chỉ placeholder.
- User guide nhắc nguyên tắc: không paste secret vào chat, không share chat public.
- Ops guide có checklist key rotation quarterly.

## Next steps
- Sau D+30 post-mortem: quyết định xóa Claude Desktop path hay giữ.
- Optional: OIDC integration (nếu công ty deploy Keycloak/Authentik).
- Optional: expose `/llm/*` cho dev tools (Cursor, Continue.dev) — mở khi có TLS.

## Completion
Đây là phase cuối. Sau khi complete:
- Update `plan.md` status → `completed`.
- Archive plan qua `/ck:plan archive`.
- Journal entry qua `/ck:journal`.
