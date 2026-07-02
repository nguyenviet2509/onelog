# Deployment Guide — LLM Provider Abstraction (Plan 260701-1544)

> Deploy `litellm-proxy` + `openwebui` + agent LiteLLM adapter lên `logserver` (192.168.122.53).
> **Prerequisite:** stack hiện tại đã chạy OK theo [deployment-guide.md](deployment-guide.md).
> **Bối cảnh:** thay Anthropic direct SDK bằng LiteLLM để hỗ trợ 4 provider (Claude/GPT/Gemini/DeepSeek), giảm cost bằng Gemini Flash default.

## 1. Topology (delta so với deployment-guide.md)

```
logserver (192.168.122.53) — thêm 2 container vào stack:
   ┌────────────────────────────────────┐
   │  litellm-proxy  : 4000 (127.0.0.1) │  profile: llm
   │  openwebui      : 8090 (127.0.0.1) │  profile: chat
   └────────────────────────────────────┘
             │
             ├─ Caddy /llm/*    → litellm-proxy:4000
             └─ Caddy /webui/*  → openwebui:8080
```

Không thay đổi service hiện có (mcp-vl, mcp-semantic, victorialogs, postgres, ...).

---

## 2. Pre-requisites

- Đã có deploy hiện tại chạy OK (`docker compose ps` all healthy)
- Ít nhất 1 provider API key (Anthropic, OpenAI, Gemini, DeepSeek)
- Tools: `age` (`sudo apt install age`), `openssl`, `psql` client trong postgres container

---

## 3. Pull code + update .env

### 3.1 Pull mới nhất
```bash
cd /opt/onelog
git status                              # đảm bảo không có local change
git fetch origin
git log --oneline origin/master -8      # verify có 3 commit LLM abstraction:
                                        #   07a4629 feat(infra): OpenWebUI
                                        #   fc8e738 feat(infra): LiteLLM proxy
                                        #   31f9644 feat(agent): LiteLLM adapter
git pull origin master
```

### 3.2 Sinh secrets + merge .env
```bash
cd /opt/onelog/infra
diff .env.example .env | less           # xem biến mới cần thêm

# Sinh secrets
export LITELLM_MASTER_KEY="sk-litellm-$(openssl rand -hex 32)"
export OPENWEBUI_SECRET_KEY="$(openssl rand -hex 32)"
export MCP_TOKEN_OPENWEBUI="sk-mcp-openwebui-$(openssl rand -hex 24)"
echo "LITELLM_MASTER_KEY=$LITELLM_MASTER_KEY"
echo "OPENWEBUI_SECRET_KEY=$OPENWEBUI_SECRET_KEY"
echo "MCP_TOKEN_OPENWEBUI=$MCP_TOKEN_OPENWEBUI"
```

Paste 3 giá trị vào `.env`:
```env
LLM_MODEL=gemini/gemini-2.5-flash
LLM_MAX_TOKENS=2048
LLM_FALLBACK_MODELS=openai/gpt-4.1-mini,anthropic/claude-sonnet-4-5
LLM_ENABLE_PROMPT_CACHE=true

LITELLM_MASTER_KEY=sk-litellm-<paste>
LITELLM_DATABASE_URL=postgresql://rag:${POSTGRES_PASSWORD}@postgres:5432/rag?options=-csearch_path%3Dlitellm

OPENWEBUI_SECRET_KEY=<paste>
OPENWEBUI_LITELLM_VIRTUAL_KEY=          # để trống, generate sau Step 5

MCP_TOKEN_OPENWEBUI=sk-mcp-openwebui-<paste>
```

### 3.3 Tách provider keys (RT-F1 blast radius)
```bash
sudo install -m 0400 -o root -g root \
  infra/litellm/.env.llm.example infra/litellm/.env.llm
sudo $EDITOR infra/litellm/.env.llm    # paste real provider keys
```

### 3.4 Thêm token OpenWebUI vào MCP bearer table
Trong `.env`, tìm `MCP_BEARER_TOKENS` (nếu chưa có, khởi tạo):
```env
MCP_BEARER_TOKENS=alice:sk-mcp-alice-xxx,bob:sk-mcp-bob-yyy,openwebui:sk-mcp-openwebui-<paste>
```

---

## 4. Bootstrap Postgres schema

```bash
docker cp /opt/onelog/infra/litellm/init-schema.sql ragstack-postgres:/tmp/
docker compose exec postgres psql -U rag -d rag -f /tmp/init-schema.sql
# → CREATE SCHEMA / GRANT / ALTER DEFAULT PRIVILEGES
```

Verify:
```bash
docker compose exec postgres psql -U rag -d rag -c "\dn"
# schema `litellm` phải xuất hiện
```

---

## 5. Deploy LiteLLM proxy

```bash
cd /opt/onelog/infra
docker compose --profile llm up -d litellm-proxy
docker compose ps litellm-proxy         # chờ healthy ~30s

# Verify liveness
curl -fsS http://localhost:4000/health/liveliness && echo "OK"

# Verify 4 model alias
curl -fsS http://localhost:4000/v1/models \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" | jq '.data[].id'
# → gemini-flash, gpt-4-mini, claude-sonnet, deepseek

# Log JSON tail
docker compose logs -f litellm-proxy | head -30
```

### 5.1 Tạo virtual key cho OpenWebUI
```bash
curl -X POST http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "models": ["gemini-flash", "gpt-4-mini", "claude-sonnet", "deepseek"],
    "max_budget": 20,
    "budget_duration": "30d",
    "soft_budget": 16,
    "key_alias": "openwebui-team"
  }' | jq -r '.key'
```

Copy key trả về (dạng `sk-...`) → paste vào `.env`:
```env
OPENWEBUI_LITELLM_VIRTUAL_KEY=sk-<paste>
```

Verify:
```bash
curl -fsS http://localhost:4000/v1/models \
  -H "Authorization: Bearer $OPENWEBUI_LITELLM_VIRTUAL_KEY" | jq '.data | length'
# → 4
```

---

## 6. Deploy OpenWebUI

### 6.1 Bootstrap admin lần đầu
Mở `.env` tạm thời uncomment 2 dòng bootstrap:
```env
OPENWEBUI_BOOTSTRAP_ADMIN_EMAIL=admin@onelog.local
OPENWEBUI_BOOTSTRAP_ADMIN_PASSWORD=<strong-password>
```

Đồng thời trong `docker-compose.yml` (section `openwebui.environment`) uncomment 2 dòng:
```yaml
WEBUI_ADMIN_EMAIL: ${OPENWEBUI_BOOTSTRAP_ADMIN_EMAIL:-}
WEBUI_ADMIN_PASSWORD: ${OPENWEBUI_BOOTSTRAP_ADMIN_PASSWORD:-}
```

Deploy:
```bash
docker compose --profile chat up -d openwebui
docker compose ps openwebui             # chờ healthy ~1 phút (first-run DB migrate)
docker compose logs -f openwebui | grep -i "admin\|user\|init"
```

### 6.2 Verify + lock signup
- Mở browser: `http://192.168.122.53/webui/`
- Login với admin credentials ở trên
- Vào **Admin Settings → Models** → verify 4 model từ LiteLLM hiện diện
- Vào **Admin Settings → Connections** hoặc **MCP** → verify 2 server `onelog-vl` + `onelog-semantic` connect (list tools load được)

Sau khi verify OK, **comment lại** 2 dòng bootstrap trong `.env` VÀ `docker-compose.yml`, restart:
```bash
docker compose restart openwebui
```

### 6.3 Tạo tài khoản 5 ops
Trong OpenWebUI: **Admin Panel → Users → + Add User** → nhập email + password mỗi ops.
Gửi credentials qua kênh private (không Slack public).

---

## 7. Update agent service (LiteLLM adapter)

Agent tự dùng LiteLLM trực tiếp (không qua proxy). Chỉ cần rebuild:

```bash
docker compose build agent
docker compose up -d agent
docker compose logs -f --tail=50 agent
# → verify log line: llm.ready model=... fallbacks=[...]
```

**Lưu ý:** agent service tự đọc `LLM_MODEL`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, ... từ `.env` global. Không dùng proxy virtual key ở slice đầu (giữ đơn giản).

---

## 8. Smoke test (theo thứ tự)

### 8.1 LiteLLM proxy direct
```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-flash","messages":[{"role":"user","content":"hello VN"}]}' \
  | jq '.choices[0].message.content'
```
Kỳ vọng: text response, HTTP 200.

### 8.2 LiteLLM qua Caddy
```bash
curl -X POST http://192.168.122.53/llm/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-flash","messages":[{"role":"user","content":"ping"}]}' \
  | jq .
```

### 8.3 Fallback chain (RT-F10 validation)
Tạm rename `GEMINI_API_KEY` trong `.env.llm` → `_GEMINI_API_KEY`, restart:
```bash
docker compose restart litellm-proxy
sleep 20
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-flash","messages":[{"role":"user","content":"ping"}]}'
# → response 200 (từ gpt-4-mini fallback)
docker compose logs litellm-proxy | grep -i "fallback\|retry" | head -5
```
Khôi phục `GEMINI_API_KEY` name sau khi verify OK.

### 8.4 Agent /chat với LiteLLM
```bash
curl -N -X POST http://192.168.122.53/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"query":"mysql có lỗi gì gần đây?"}' \
  | grep -E '^event:|^data:' | head -30
```
Kỳ vọng: SSE events `thinking`, `tool_call`, `tool_result`, `answer` — parity với Anthropic baseline. Citation `[svc:host:...]` hợp lệ.

### 8.5 OpenWebUI qua Caddy
- Mở `http://192.168.122.53/webui/` → login user
- Chọn model `gemini-flash` (default)
- Chat: `Dùng search_log_templates tìm log mysql`
- Verify: tool được gọi, response có citation với `vmui_url` click được

### 8.6 Cost tracking
```bash
curl -fsS http://localhost:4000/spend/logs \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" | jq '.[] | {model, spend, user, ts: .startTime}'
```
Kỳ vọng: 1+ record cho mỗi request smoke test.

---

## 9. Backup + monitoring

### 9.1 Age keypair cho OpenWebUI backup
```bash
sudo mkdir -p /root/vault /etc/onelog
sudo age-keygen -o /root/vault/backup-age.key
sudo chmod 0400 /root/vault/backup-age.key
sudo grep "public key" /root/vault/backup-age.key | awk '{print $NF}' \
  | sudo tee /etc/onelog/backup-age.pub
```

**QUAN TRỌNG:** copy `/root/vault/backup-age.key` sang ops vault (offsite). Nếu mất key này → không restore được backup.

### 9.2 Test backup script
```bash
sudo bash /opt/onelog/infra/scripts/backup-openwebui.sh
ls -lh /opt/onelog/backup/openwebui-*.tgz.age
```

### 9.3 Cron daily 3AM
```bash
(sudo crontab -l 2>/dev/null; \
 echo "0 3 * * * /opt/onelog/infra/scripts/backup-openwebui.sh >> /var/log/openwebui-backup.log 2>&1") \
 | sudo crontab -
```

---

## 10. Verification checklist

- [ ] `git pull` thành công, có 3 commit LLM abstraction
- [ ] `.env` có đủ biến mới, `.env.llm` chmod 0400 root:root
- [ ] `docker compose exec postgres psql -c "\dn"` show schema `litellm`
- [ ] `docker compose ps litellm-proxy openwebui` → cả 2 healthy
- [ ] `curl /v1/models` list 4 model alias
- [ ] Fallback chain verify OK (rename key + retry)
- [ ] Agent `/api/chat` SSE stream trả answer với citation hợp lệ
- [ ] OpenWebUI login OK, thấy 4 model + MCP tools
- [ ] Chat mẫu qua OpenWebUI: tool call + citation OK
- [ ] `curl /spend/logs` có record cost
- [ ] Backup script dry-run OK, file `.tgz.age` xuất hiện
- [ ] Cron backup daily active
- [ ] `systemctl status ragstack` vẫn healthy (compose profile thêm không phá base)

---

## 11. Troubleshooting

| Triệu chứng | Check | Fix |
|---|---|---|
| `litellm-proxy` restart loop, log `pydantic ValidationError config.yaml` | Config YAML sai schema | Verify `provider/model` format đúng; check LiteLLM version bump breaking change |
| `curl /v1/models` → 401 | Master key sai / chưa export | `export LITELLM_MASTER_KEY=$(grep LITELLM_MASTER_KEY infra/.env \| cut -d= -f2)` |
| `curl /v1/models` → 500 provider unreachable | Egress proxy chặn provider | Set `HTTPS_PROXY` trong `.env.llm` |
| Callback module import error `No module named 'custom_callbacks'` | Volume mount sai path | Verify `docker exec ragstack-litellm ls /app/custom_callbacks.py` — file phải hiện |
| OpenWebUI login fail "Failed to connect to backend" | `OPENAI_API_BASE_URL` sai / LiteLLM chưa up | Verify service `litellm-proxy` resolve trong docker network |
| OpenWebUI model list empty | Virtual key không có model permission | Regen key với `"models":[...]` đầy đủ |
| OpenWebUI MCP tools không hiện | `mcp-config.json` mount fail / bearer token sai | `docker exec ragstack-openwebui cat /app/backend/data/mcp-config.json`; check `openwebui:$MCP_TOKEN_OPENWEBUI` có trong `MCP_BEARER_TOKENS` |
| Agent SSE trả `LLM error: BadRequestError` | Message shape adapter miss edge case | Xem log agent chi tiết; report bug Phase 1 với reproducer |
| Caddy 502 khi vào `/webui/` | OpenWebUI chưa healthy / route missing | `docker compose logs openwebui`; verify Caddyfile có `handle_path /webui*` |
| Cost tracking trống | `LITELLM_DATABASE_URL` không set / schema chưa init | Chạy lại Step 4 bootstrap schema |
| Provider trả `429 rate limit` liên tục | Vượt quota provider | LiteLLM tự retry + fallback; tăng budget provider hoặc đổi default model |
| Backup script fail `age public key not found` | Chưa chạy Step 9.1 | Generate keypair + publish `.pub` |
| `age: cannot open output file` | Backup dir không tồn tại / permission | `sudo mkdir -p /opt/onelog/backup && sudo chown ragops:ragops /opt/onelog/backup` |

---

## 12. Rollback

### Full rollback (về Anthropic direct)
```bash
cd /opt/onelog
git log --oneline -10                   # tìm commit trước 31f9644
git checkout <sha-before-llm-plan>
docker compose --profile chat --profile llm down
docker compose build agent
docker compose up -d agent
# Stack quay về Anthropic direct SDK, Claude Desktop path không đổi
```

### Partial rollback (giữ proxy + openwebui, agent về Claude direct)
```bash
# .env
LLM_MODEL=anthropic/claude-sonnet-4-5
docker compose restart agent
```

### Postgres schema rollback
```bash
docker compose --profile llm down litellm-proxy
docker compose exec postgres psql -U rag -d rag -c "DROP SCHEMA litellm CASCADE;"
# Không ảnh hưởng rag-agent tables trong `public`
```

---

## 13. Post-deploy tasks

- [ ] Update `/etc/onelog-ragstack.env` (systemd unit) profile: `COMPOSE_PROFILES=agent,mcp,chat,llm`
- [ ] Reboot logserver test → verify `openwebui` + `litellm-proxy` tự up sau boot
- [ ] Add openwebui volume vào `snapshot-daily.sh` nếu retention offsite cần thiết
- [ ] Vector config: thêm route tail `docker logs ragstack-litellm` → VictoriaLogs (cost analytics)
- [ ] Gửi 5 ops link `/webui/` + credential qua kênh private

---

## 14. Unresolved questions

1. Cost tracking Postgres vs stdout JSON — chọn 1 hay dual-write cho redundancy?
2. Systemd `ragstack.service` có nên tự bao gồm profile `llm,chat` chưa hay để manual up?
3. Snapshot offsite (S3/MinIO) cho backup-openwebui `.tgz.age` — có tồn tại storage không?
