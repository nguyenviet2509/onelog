# Deployment Guide — LLM Provider Abstraction (Plan 260701-1544)

> Deploy `litellm-proxy` + `openwebui` + agent LiteLLM adapter lên `logserver`.
> **Prerequisite:** stack hiện tại chạy OK theo [deployment-guide.md](deployment-guide.md).
> **Đã verify end-to-end** trên `logserver-01` — 2026-07-02.
> **Bối cảnh:** thay Anthropic direct SDK bằng LiteLLM để hỗ trợ 4 provider (Claude/GPT/Gemini/DeepSeek), giảm cost bằng Gemini Flash default.

## 0. Golden rules (đọc trước khi động)

1. **Mọi `docker compose ...` phải chạy từ `~/onelog/infra`.** Đứng ở root repo (`~/onelog`) sẽ báo `no configuration file provided: not found`.
2. **`docker compose up/logs/exec` cần đúng `--profile`.** Services trong profile khác không hiện. Ví dụ `agent` service trong `[agent]` profile, `openwebui` trong `[chat]`, `litellm-proxy` trong `[llm, chat]`.
3. **`docker cp` không cần compose file** — gọi thẳng container name. Dùng khi copy config vào container.
4. **DB backend cho LiteLLM đã DISABLED** — Prisma ignore Postgres `search_path` → schema isolation là no-op. Cost tracking qua stdout JSON → VictoriaLogs. Virtual keys in-memory. Cho MVP dùng master key trực tiếp cho OpenWebUI.

## 1. Topology (delta so với stack cũ)

```
logserver — thêm 2 container vào stack:
   ┌────────────────────────────────────┐
   │  litellm-proxy  : 4000 (127.0.0.1) │  profiles: [llm, chat]
   │  openwebui      : 8090 (127.0.0.1) │  profiles: [chat]
   └────────────────────────────────────┘
             │
             ├─ Caddy site  webui.local  → openwebui:8080  (dedicated hostname)
             │  (KHÔNG dùng /webui/* prefix — OpenWebUI static assets root-relative)
             └─ Caddy site  app.local
                 └─ /llm/* → litellm-proxy:4000  (streaming completions)
```

Container `agent` cũ (từ pre-MCP-only rollout) đã bị comment out — restore trong commit `373053d` với LiteLLM envs.

## 2. Pre-requisites

- Stack hiện tại `docker compose ps` toàn healthy
- Ít nhất 1 provider API key (Anthropic / OpenAI / Gemini / DeepSeek). Nếu chưa có, vẫn deploy được nhưng chat sẽ trả `AuthenticationError`.
- Tools trên logserver: `age` (`sudo apt install age`), `openssl`
- Tools trên workstation: quyền admin/sudo để edit `hosts` file

## 3. Pull code + gen secrets

### 3.1 Pull
```bash
cd ~/onelog
git status                              # đảm bảo không có local change
git fetch origin
git pull origin master
```

Verify commits present (7 commit Phase 1-3 + fixes):
```bash
git log --oneline -12
# Cần có (mới nhất trước):
#   373053d feat(infra): re-enable agent service with LiteLLM env vars
#   6434949 fix(caddy): serve OpenWebUI at dedicated webui.local
#   31643ec fix(litellm): disable Postgres backend
#   ...
#   31f9644 feat(agent): abstract LLM provider via LiteLLM adapter
```

### 3.2 Nếu server có local changes gây conflict
Thường do session trước uncomment `WEBUI_ADMIN_*` cho bootstrap. Nếu đã bootstrap admin xong, discard là an toàn:
```bash
git stash push -m "openwebui bootstrap local edits"
git pull origin master
git stash list    # phòng khi cần khôi phục sau
```

### 3.3 Sinh 3 secret
```bash
echo "LITELLM_MASTER_KEY=sk-litellm-$(openssl rand -hex 32)"
echo "OPENWEBUI_SECRET_KEY=$(openssl rand -hex 32)"
echo "MCP_TOKEN_OPENWEBUI=sk-mcp-openwebui-$(openssl rand -hex 24)"
```

Copy 3 giá trị vào `~/onelog/infra/.env`.

## 4. Merge .env

### 4.1 Backup + dedupe (fix bug từ manual edits)
```bash
cd ~/onelog/infra
cp .env .env.bak-$(date +%Y%m%d-%H%M)
awk '!seen[$0]++' .env > .env.tmp && mv .env.tmp .env
# Verify no duplicate EMBED_MOCK
grep -c "^EMBED_MOCK=" .env    # phải trả về 1
```

### 4.2 Append block LLM abstraction vào cuối .env
```env
# ─── LLM Provider Abstraction (plan 260701-1544) ─────────────────────
LLM_MODEL=anthropic/claude-sonnet-4-5
LLM_MAX_TOKENS=2048
LLM_FALLBACK_MODELS=
LLM_ENABLE_PROMPT_CACHE=true

# Provider keys (cho agent service — LiteLLM SDK direct, không qua proxy)
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
# ANTHROPIC_API_KEY và OPENAI_API_KEY đã có sẵn ở block LLM cũ, không lặp

# LiteLLM proxy (profiles: llm, chat)
LITELLM_MASTER_KEY=sk-litellm-<paste>
OPENWEBUI_SECRET_KEY=<paste>

# OpenWebUI dùng master key trực tiếp (MVP, không có DB backend).
# Đổi sang virtual key riêng nếu enable DB sau này.
OPENWEBUI_LITELLM_VIRTUAL_KEY=${LITELLM_MASTER_KEY}

# MCP token riêng cho OpenWebUI (RT-F3)
MCP_TOKEN_OPENWEBUI=sk-mcp-openwebui-<paste>
```

### 4.3 Update MCP_BEARER_TOKENS
Dòng cũ format `user:token,user:token`. Append entry `openwebui` — KHÔNG xóa entry cũ:
```
MCP_BEARER_TOKENS=trihd:sk-mcp-...,openwebui:sk-mcp-openwebui-<paste>
```

### 4.4 Chuyển LLM_MOCK khi có key
```bash
# Chỉ chạy khi có ≥ 1 provider key thật
sed -i 's/^LLM_MOCK=true/LLM_MOCK=false/' .env
```

## 5. Tách `.env.llm` cho LiteLLM proxy (RT-F1)

```bash
sudo install -m 0400 -o root -g root \
  ~/onelog/infra/litellm/.env.llm.example \
  ~/onelog/infra/litellm/.env.llm
sudo vi ~/onelog/infra/litellm/.env.llm
# Điền provider keys THẬT vào đây (nếu có)
```

**Design intent:** provider keys tại đây tách khỏi `.env` global. Nếu `.env` leak, key vẫn an toàn (blast radius separation).

## 6. Deploy LiteLLM proxy

```bash
cd ~/onelog/infra
docker compose --profile llm up -d litellm-proxy
sleep 30    # first-run cần ~20s để load config + start uvicorn
docker compose ps litellm-proxy       # → Up, healthy

# Verify liveness
curl -fsS http://localhost:4000/health/liveliness && echo " OK"

# Load master key vào shell + list 4 model alias
export LITELLM_MASTER_KEY=$(grep '^LITELLM_MASTER_KEY=' .env | cut -d= -f2)
curl -fsS http://localhost:4000/v1/models \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" | jq '.data[].id'
# → "gemini-flash", "gpt-4-mini", "claude-sonnet", "deepseek"
```

### Troubleshooting LiteLLM

**Symptom:** `curl: (56) Recv failure: Connection reset by peer` sau khi container "Up" 30s
- **Cause:** LiteLLM chưa listen 4000 (crash bootstrap) hoặc Prisma migration đang chạy 20+ phút
- **Fix nếu do migration:** đảm bảo `database_url` trong `config.yaml` đã comment (đã fix trong commit `31643ec`). Nếu vẫn migrating → `docker compose --profile llm down litellm-proxy && git pull && docker compose --profile llm up -d`

**Symptom:** `docker compose logs litellm-proxy` báo `ModuleNotFoundError: custom_callbacks`
- **Cause:** Bind mount `custom_callbacks.py` không đúng path
- **Fix:** `docker exec ragstack-litellm ls /app/custom_callbacks.py` → phải hiện. Nếu missing → verify volume mount trong compose

## 7. Deploy OpenWebUI

### 7.1 Bootstrap admin (chỉ lần đầu, DB rỗng)
Thêm vào `.env`:
```env
OPENWEBUI_BOOTSTRAP_ADMIN_EMAIL=admin@onelog.local
OPENWEBUI_BOOTSTRAP_ADMIN_PASSWORD=<mật-khẩu-tạm-mạnh>
```

Uncomment 2 dòng trong `docker-compose.yml` section `openwebui.environment`:
```bash
sed -i 's|^      # WEBUI_ADMIN_EMAIL:|      WEBUI_ADMIN_EMAIL:|' docker-compose.yml
sed -i 's|^      # WEBUI_ADMIN_PASSWORD:|      WEBUI_ADMIN_PASSWORD:|' docker-compose.yml
```

### 7.2 Deploy
```bash
docker compose --profile chat up -d openwebui
# LƯU Ý: --profile chat tự động bring litellm-proxy nếu chưa chạy
# (litellm-proxy đã trong cả 2 profile llm và chat)

sleep 60    # first-run migrate SQLite + download embedding model ~60s
docker compose --profile chat ps openwebui    # → healthy
docker compose --profile chat logs openwebui --tail=30 | grep -iE "admin|user|running"
# Kỳ vọng: "Admin account created successfully: admin@onelog.local"
```

### 7.3 Setup Caddy site cho webui.local

Caddyfile đã có sẵn site block `http://webui.local` từ commit `6434949`. Reload:
```bash
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
# Nếu reload fail → docker compose restart caddy
```

### 7.4 Setup /etc/hosts trên workstation
**Windows** (PowerShell as Administrator):
```powershell
Add-Content -Path "$env:windir\System32\drivers\etc\hosts" -Value "192.168.122.53  webui.local"
ping webui.local    # phải reply từ 192.168.122.53
```

**macOS/Linux:**
```bash
echo "192.168.122.53  webui.local" | sudo tee -a /etc/hosts
```

### 7.5 Verify + lock signup

Mở browser: **http://webui.local/**
- Login: `admin@onelog.local` + password bootstrap
- **Settings → Admin Settings → Models** → thấy 4 model từ LiteLLM
- **Settings → Account → Change password** — ĐỔI NGAY (password bootstrap ở .env)

Sau khi verify OK, lock:
```bash
cd ~/onelog/infra
# Comment .env
sed -i 's|^OPENWEBUI_BOOTSTRAP_ADMIN|# OPENWEBUI_BOOTSTRAP_ADMIN|' .env
# Comment docker-compose.yml
sed -i 's|^      WEBUI_ADMIN_EMAIL:|      # WEBUI_ADMIN_EMAIL:|' docker-compose.yml
sed -i 's|^      WEBUI_ADMIN_PASSWORD:|      # WEBUI_ADMIN_PASSWORD:|' docker-compose.yml
# Restart OpenWebUI
docker compose --profile chat restart openwebui
```

### Troubleshooting OpenWebUI

**Symptom:** browser tại `webui.local` show "onelog: web UI deprecated"
- **Cause:** Caddy Caddyfile chưa reload sau khi có commit `6434949`, hoặc site block `http://webui.local` chưa tồn tại
- **Fix:** `docker compose restart caddy`, sau đó test `curl -H "Host: webui.local" http://localhost/`

**Symptom:** compose báo `service "openwebui" depends on undefined service "litellm-proxy"`
- **Cause:** Chỉ dùng `--profile chat` với version cũ khi litellm-proxy chỉ trong profile `[llm]`
- **Fix:** Đã fix trong commit này — litellm-proxy giờ ở `[llm, chat]`. `git pull` để có fix. Alternatively: `docker compose --profile llm --profile chat up -d openwebui`

## 8. Deploy agent service với LiteLLM adapter

### 8.1 Stop container cũ (Anthropic direct)
Container `ragstack-agent` cũ Up 8+ days từ image trước LiteLLM:
```bash
docker stop ragstack-agent 2>/dev/null || true
docker rm ragstack-agent 2>/dev/null || true
```

### 8.2 Build + start qua compose
```bash
cd ~/onelog/infra
docker compose --profile agent build agent
docker compose --profile agent up -d agent
sleep 10
docker compose --profile agent ps agent    # → Up
docker compose --profile agent logs agent --tail=30
```

Kỳ vọng log:
- `Started server process [1]`
- `Uvicorn running on http://0.0.0.0:8080`
- Log line `llm.ready model=...` (real key) hoặc `llm.mock_mode` (không có key / LLM_MOCK=true)

### 8.3 Smoke test `/chat` SSE
```bash
curl -N -X POST http://localhost:8080/chat \
  -H 'Content-Type: application/json' \
  -d '{"query":"mysql có lỗi gì gần đây?"}' 2>&1 | head -40
```

**Kỳ vọng theo key state:**

| State | Output |
|---|---|
| `LLM_MOCK=true` | SSE stream đầy đủ: `thinking` → `tool_call` → `tool_result` → `answer` (canned) |
| Key sai / placeholder `sk-ant-...` | `event: error` với `AuthenticationError: invalid x-api-key` — đây là **kết quả tốt**, chứng minh adapter shape đúng, chỉ thiếu key |
| Key thật | SSE stream với answer thực từ provider |

## 9. Setup backup OpenWebUI (RT-F4)

### 9.1 Age keypair
```bash
sudo mkdir -p /root/vault /etc/onelog
sudo age-keygen -o /root/vault/backup-age.key
sudo chmod 0400 /root/vault/backup-age.key
sudo grep "public key" /root/vault/backup-age.key | awk '{print $NF}' \
  | sudo tee /etc/onelog/backup-age.pub
```

**QUAN TRỌNG:** copy `/root/vault/backup-age.key` sang ops vault (offsite). Mất key này = mất khả năng restore.

### 9.2 Test + cron
```bash
sudo bash ~/onelog/infra/scripts/backup-openwebui.sh
ls -lh ~/onelog/backup/openwebui-*.tgz.age

# Cron 3am daily
(sudo crontab -l 2>/dev/null; \
 echo "0 3 * * * ~/onelog/infra/scripts/backup-openwebui.sh >> /var/log/openwebui-backup.log 2>&1") \
 | sudo crontab -
```

## 10. Verification checklist

- [ ] `git log --oneline -8` có đủ commit LLM abstraction
- [ ] `.env` không còn duplicate `EMBED_MOCK`, có block LLM mới
- [ ] `.env.llm` chmod 0400 root:root, có provider keys thật (hoặc empty nếu chưa có)
- [ ] `docker compose --profile llm --profile chat --profile agent ps` — litellm-proxy + openwebui + agent đều healthy
- [ ] `curl /v1/models` list 4 model
- [ ] `curl -H "Host: webui.local" http://localhost/` → không 410
- [ ] Browser `http://webui.local/` login OK, thấy 4 model
- [ ] Admin password đã đổi khỏi bootstrap
- [ ] `.env` + `docker-compose.yml` đã lock signup (WEBUI_ADMIN_* comment)
- [ ] `curl POST /chat` SSE stream trả events (mock hoặc real)
- [ ] Backup script chạy được, `.tgz.age` xuất hiện
- [ ] Cron backup active

## 11. Troubleshooting bảng tổng

| Triệu chứng | Root cause | Fix |
|---|---|---|
| `no configuration file provided: not found` | Đang ở `~/onelog`, không phải `~/onelog/infra` | `cd ~/onelog/infra` |
| `no such service: X` | Thiếu `--profile` phù hợp | `docker compose --profile agent ps agent` (hoặc `llm`/`chat`) |
| LiteLLM `Recv failure: Connection reset by peer` sau > 30s | Config `database_url` chưa comment → Prisma stuck migration | `git pull` (commit `31643ec` đã fix); `docker compose --profile llm down litellm-proxy && up -d` |
| `service "openwebui" depends on undefined service "litellm-proxy"` | litellm-proxy chỉ ở profile `[llm]`, `--profile chat` không thấy | `git pull` (commit đã fix — litellm-proxy giờ trong `[llm, chat]`) |
| `key/generate` trả `DB not connected` | LiteLLM không có DB backend | Dùng master key trực tiếp cho `OPENWEBUI_LITELLM_VIRTUAL_KEY=${LITELLM_MASTER_KEY}` |
| Browser `/webui/` show "web UI deprecated" 410 | Caddy path prefix routing không hoạt động với OpenWebUI root-relative assets | Dùng subdomain `webui.local` (commit `6434949`) + hosts entry |
| `AuthenticationError: invalid x-api-key` từ `/chat` | Provider key trong `.env` là placeholder `sk-ant-...` | Điền key thật vào `.env` (agent) và/hoặc `.env.llm` (proxy) |
| `Missing Gemini API key` từ OpenWebUI chat | `GEMINI_API_KEY` trong `.env.llm` empty | `sudo vi .env.llm` điền key + `docker compose --profile llm restart litellm-proxy` |
| Git pull báo `local changes would be overwritten` | Session cũ uncomment bootstrap còn trong file | `git stash push` + `git pull` |
| Windows: `EPERM` khi save hosts từ VS Code | Windows Defender / permission | PowerShell as admin: `Add-Content -Path "$env:windir\System32\drivers\etc\hosts" -Value "..."` |

## 12. Rollback

```bash
cd ~/onelog
# Full rollback về pre-LLM-abstraction
git log --oneline --grep="feat(agent): abstract"    # tìm SHA
git checkout <sha-before-31f9644>
cd infra
docker compose --profile chat --profile llm --profile agent down
docker compose --profile agent build agent
docker compose --profile agent up -d agent
```

Partial rollback (agent về mock hoặc Anthropic direct nhưng giữ litellm-proxy + openwebui):
```bash
# .env
LLM_MODEL=anthropic/claude-sonnet-4-5    # hoặc LLM_MOCK=true
docker compose --profile agent restart agent
```

## 13. Post-deploy tasks

- [ ] Update `/etc/onelog-ragstack.env` (systemd unit) profile: `COMPOSE_PROFILES=agent,mcp,alerts,llm,chat`
- [ ] Reboot logserver test → verify auto-start
- [ ] Add openwebui volume vào `snapshot-daily.sh` nếu retention offsite cần thiết
- [ ] Điền provider keys thật khi có
- [ ] Đổi password admin OpenWebUI qua UI (khỏi password bootstrap)
- [ ] DROP schema `litellm` orphan nếu đã tạo:
  ```bash
  docker compose exec postgres psql -U rag -d rag -c "DROP SCHEMA IF EXISTS litellm CASCADE;"
  ```

## 14. Unresolved / defer

1. **Virtual key với budget cap** — cần DB. Nếu team cần track cost per-user, tạo dedicated DB `litellm` (không phải schema): `CREATE DATABASE litellm;` + uncomment `DATABASE_URL` trong `docker-compose.yml` (URL trỏ `postgres:5432/litellm` không có options).
2. **HTTPS** — hiện Caddy `auto_https off`. Khi có domain thật + LE cert, thay `http://webui.local` bằng domain.
3. **OIDC/SSO** — hiện local user table. Tích hợp sau nếu có Keycloak/Authentik.
4. **VMalert alert rule** cho `budget_alert` event từ LiteLLM stdout logs.
