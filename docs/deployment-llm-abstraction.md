# Deploy LLM Provider Abstraction

> Plan `260701-1544` · deploy `litellm-proxy` + `openwebui` + agent LiteLLM adapter lên logserver.
> Verified end-to-end trên `logserver-01` — 2026-07-02.

## Golden rules

1. `docker compose ...` **luôn chạy từ `~/onelog/infra`**. Đứng ở `~/onelog` sẽ báo `no configuration file provided`.
2. Services có profile — luôn kèm flag: `--profile agent`, `--profile chat` (kéo cả `litellm-proxy`), `--profile llm`.
3. Provider keys ở 2 nơi:
   - `.env` (global) — cho **agent** dùng LiteLLM SDK trực tiếp.
   - `.env.llm` (chmod 0400) — cho **litellm-proxy** container.
4. LiteLLM DB backend **đã tắt** — dùng master key trực tiếp cho OpenWebUI, cost log qua stdout JSON.

---

## Quick deploy (copy-paste)

Trên logserver, khi đã có ít nhất 1 provider key:

```bash
# 1. Pull latest
cd ~/onelog && git pull origin master

# 2. Gen 3 secret, in ra để copy
echo "LITELLM_MASTER_KEY=sk-litellm-$(openssl rand -hex 32)"
echo "OPENWEBUI_SECRET_KEY=$(openssl rand -hex 32)"
echo "MCP_TOKEN_OPENWEBUI=sk-mcp-openwebui-$(openssl rand -hex 24)"

# 3. Backup .env + dedupe + edit
cd ~/onelog/infra
cp .env .env.bak-$(date +%Y%m%d-%H%M)
awk '!seen[$0]++' .env > .env.tmp && mv .env.tmp .env
vi .env    # paste block từ §Config .env dưới
```

Sau khi `.env` xong:

```bash
# 4. Tạo .env.llm (chmod 0400)
sudo install -m 0400 -o root -g root litellm/.env.llm.example litellm/.env.llm
sudo vi litellm/.env.llm    # điền provider keys thật

# 5. Deploy 3 container
docker compose --profile llm --profile chat --profile agent build agent
docker compose --profile llm --profile chat --profile agent up -d litellm-proxy openwebui agent

sleep 60
docker compose --profile llm --profile chat --profile agent ps

# 6. Reload Caddy để pick up webui.local site
docker compose restart caddy

# 7. Smoke test
export LITELLM_MASTER_KEY=$(grep '^LITELLM_MASTER_KEY=' .env | cut -d= -f2)
curl -fsS http://localhost:4000/health/liveliness && echo " OK"
curl -fsS http://localhost:4000/v1/models -H "Authorization: Bearer $LITELLM_MASTER_KEY" | jq '.data[].id'
curl -fsS http://localhost:8080/health && echo " agent OK"
```

Trên workstation, thêm `hosts` entry (chạy 1 lần):

- **Windows** (PowerShell as Admin): `Add-Content -Path "$env:windir\System32\drivers\etc\hosts" -Value "192.168.122.53  webui.local"`
- **macOS/Linux**: `echo "192.168.122.53  webui.local" | sudo tee -a /etc/hosts`

Mở browser: **http://webui.local/** → bootstrap admin (§Bootstrap admin dưới).

---

## Config .env (block cần add)

Append vào cuối `~/onelog/infra/.env`:

```env
# ─── LLM Provider Abstraction (plan 260701-1544) ─────────────────────
LLM_MODEL=anthropic/claude-sonnet-4-5
LLM_MAX_TOKENS=2048
LLM_FALLBACK_MODELS=
LLM_ENABLE_PROMPT_CACHE=true
GEMINI_API_KEY=
DEEPSEEK_API_KEY=

LITELLM_MASTER_KEY=sk-litellm-<paste>
OPENWEBUI_SECRET_KEY=<paste>
OPENWEBUI_LITELLM_VIRTUAL_KEY=${LITELLM_MASTER_KEY}
MCP_TOKEN_OPENWEBUI=sk-mcp-openwebui-<paste>
```

Update dòng `MCP_BEARER_TOKENS` (append entry `openwebui:...`, không xóa entry cũ):
```
MCP_BEARER_TOKENS=trihd:sk-mcp-...,openwebui:sk-mcp-openwebui-<paste>
```

Nếu có key thật, đổi `LLM_MOCK=true` → `false`:
```bash
sed -i 's/^LLM_MOCK=true/LLM_MOCK=false/' .env
```

---

## Bootstrap admin OpenWebUI

Chỉ động `.env`, KHÔNG động `docker-compose.yml`.

```bash
# Set 2 dòng trong .env
cat >> .env <<'EOF'

OPENWEBUI_BOOTSTRAP_ADMIN_EMAIL=admin@onelog.local
OPENWEBUI_BOOTSTRAP_ADMIN_PASSWORD=ChangeMe2026!
EOF

docker compose --profile chat restart openwebui
sleep 30
docker compose --profile chat logs openwebui --tail=10 | grep -i admin
# → "Admin account created successfully: admin@onelog.local"
```

Login `http://webui.local/` → **Settings → Account → Change password** (đổi khỏi bootstrap).

Lock signup:
```bash
sed -i 's|^OPENWEBUI_BOOTSTRAP_ADMIN|# OPENWEBUI_BOOTSTRAP_ADMIN|' .env
docker compose --profile chat restart openwebui
# ENV empty → OpenWebUI skip admin creation
```

---

## Verify checklist

```bash
cd ~/onelog/infra

# 1. Container health
docker compose --profile llm --profile chat --profile agent ps
# → litellm-proxy, openwebui, agent tất cả "healthy" hoặc "Up"

# 2. LiteLLM proxy
curl -fsS http://localhost:4000/health/liveliness         # → "I'm alive!"
curl -fsS http://localhost:4000/v1/models -H "Authorization: Bearer $LITELLM_MASTER_KEY" | jq '.data | length'
# → 4

# 3. Agent SSE
curl -N -X POST http://localhost:8080/chat \
  -H 'Content-Type: application/json' \
  -d '{"query":"test"}' | head -20
# LLM_MOCK=true → SSE events canned
# Key thật    → SSE events với answer thật
# Key sai     → "event: error ... AuthenticationError" (adapter OK, chỉ thiếu key)

# 4. OpenWebUI qua Caddy
curl -fsS -H "Host: webui.local" http://localhost/ | grep -o "<title>[^<]*" | head -1
# → <title>OneLog Chat
```

---

## Backup OpenWebUI (RT-F4)

```bash
sudo mkdir -p /root/vault /etc/onelog
sudo age-keygen -o /root/vault/backup-age.key
sudo chmod 0400 /root/vault/backup-age.key
sudo grep "public key" /root/vault/backup-age.key | awk '{print $NF}' \
  | sudo tee /etc/onelog/backup-age.pub

# Test
sudo bash ~/onelog/infra/scripts/backup-openwebui.sh
ls -lh ~/onelog/backup/openwebui-*.tgz.age

# Cron
(sudo crontab -l 2>/dev/null; \
 echo "0 3 * * * $HOME/onelog/infra/scripts/backup-openwebui.sh >> /var/log/openwebui-backup.log 2>&1") \
 | sudo crontab -
```

**Copy `/root/vault/backup-age.key` sang ops vault (offsite).** Mất key = không restore được.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no configuration file provided: not found` | `cd ~/onelog/infra` trước khi chạy `docker compose` |
| `no such service: X` | Thêm `--profile agent` / `--profile chat` / `--profile llm` |
| LiteLLM stuck 20+ phút, log "Running prisma migrate" | `git pull` (fix `31643ec` disable DB backend), redeploy |
| `Recv failure: Connection reset by peer` khi curl :4000 | Chờ thêm 30s (first-run boot); nếu vẫn fail, check `docker compose logs litellm-proxy` |
| `service "openwebui" depends on undefined service "litellm-proxy"` | `git pull` (fix — litellm-proxy giờ ở cả `[llm, chat]`) |
| Browser `webui.local` → "web UI deprecated" 410 | `docker compose restart caddy` sau khi pull commit `6434949` |
| OpenWebUI login "Failed to connect to backend" | Verify `OPENAI_API_BASE_URL=http://litellm-proxy:4000/v1` + `OPENWEBUI_LITELLM_VIRTUAL_KEY` khớp master key |
| `AuthenticationError: invalid x-api-key` từ `/chat` | Adapter OK, chỉ điền `ANTHROPIC_API_KEY` thật vào `.env` + restart agent |
| `Missing Gemini API key` từ OpenWebUI | Điền `GEMINI_API_KEY` vào `.env.llm` + `docker compose --profile llm restart litellm-proxy` |
| `key/generate` báo `DB not connected` | Không tạo virtual key — dùng `OPENWEBUI_LITELLM_VIRTUAL_KEY=${LITELLM_MASTER_KEY}` |
| `git pull` báo `local changes would be overwritten` | `git stash push -m "before-pull" && git pull` |
| Windows: EPERM khi save hosts | PowerShell as admin: `Add-Content -Path "$env:windir\System32\drivers\etc\hosts" -Value "192.168.122.53 webui.local"` |

---

## Update provider keys (sau deploy)

```bash
# .env — cho agent (LiteLLM SDK direct)
sudo vi ~/onelog/infra/.env
# Sửa ANTHROPIC_API_KEY / GEMINI_API_KEY / ...
cd ~/onelog/infra
docker compose --profile agent restart agent

# .env.llm — cho litellm-proxy (OpenWebUI)
sudo vi ~/onelog/infra/litellm/.env.llm
docker compose --profile llm restart litellm-proxy
```

Verify:
```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-flash","messages":[{"role":"user","content":"hi"}]}' \
  | jq '.choices[0].message.content'
```

---

## Rollback

```bash
cd ~/onelog

# Full rollback về pre-LLM abstraction
git log --oneline | grep "feat(agent): abstract LLM"    # tìm SHA của commit đầu tiên
git checkout <sha>~1                                    # commit trước đó

cd infra
docker compose --profile agent --profile chat --profile llm down
docker compose --profile agent build agent
docker compose --profile agent up -d agent
```

Partial rollback (giữ litellm-proxy + openwebui, agent về mock):
```bash
sed -i 's/^LLM_MOCK=false/LLM_MOCK=true/' ~/onelog/infra/.env
docker compose --profile agent restart agent
```

---

## Post-deploy

- [ ] Update `/etc/onelog-ragstack.env` (systemd unit): `COMPOSE_PROFILES=agent,mcp,alerts,llm,chat`
- [ ] Reboot logserver test → verify all containers auto-up
- [ ] Copy `/root/vault/backup-age.key` sang ops vault offsite
- [ ] Đổi password admin OpenWebUI khỏi `ChangeMe2026!`
- [ ] Điền real provider keys khi có

---

## Unresolved / defer

1. **Virtual key + budget cap** — cần DB dedicated (`CREATE DATABASE litellm;`), không phải schema. Enable khi cần per-user cost history.
2. **HTTPS** — hiện `auto_https off`. Khi có domain thật, thay `http://webui.local` bằng domain + LE cert.
3. **OIDC/SSO** — local user table. Tích hợp sau nếu team dùng Keycloak/Authentik.
4. **VMalert rule cho `budget_alert` event** từ LiteLLM stdout logs.
