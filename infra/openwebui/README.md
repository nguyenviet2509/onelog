# OpenWebUI · OneMCP Bridge Install

Plan: `plans/260723-1200-onemcp-openwebui-bridge/`

## Files
```
infra/openwebui/
├── functions/
│   └── onemcp-tools.py          # LLM-callable: search / get / template / list_skills / load_skill
├── actions/
│   ├── onemcp-submit-kb.py      # Button 📚 Save to OneMCP KB
│   ├── redact.py                # Hard-block + soft redact secrets
│   └── test_redact.py           # Unit tests (chạy local trước deploy)
├── onemcp-ca.crt                # OneMCP nginx self-signed cert (mount vào container)
├── system-prompt-ops.md         # Canonical prompt — admin paste vào UI
└── README.md                    # File này
```

## Install steps (onelog-source lab, IP 192.168.122.53)

### 1. Deploy config sync từ local repo
Từ máy dev:
```powershell
rsync -avz --delete `
  d:/Vietnt/Project/onelog/infra/openwebui/ `
  onelog-source:/home/vietnt/onelog/infra/openwebui/
rsync -avz `
  d:/Vietnt/Project/onelog/infra/docker-compose.yml `
  d:/Vietnt/Project/onelog/infra/.env.example `
  onelog-source:/home/vietnt/onelog/infra/
```

### 2. Update .env trên host
```bash
ssh onelog-source
cd /home/vietnt/onelog/infra
# Append từ .env.example (ONEMCP_* section) vào .env
grep -A 100 "OneMCP bridge" .env.example | tee -a .env
# Sửa ONEMCP_ALERT_WEBHOOK_TOKEN khớp với OneMCP env
$EDITOR .env
```

### 3. Recreate openwebui (mount CA cert)
```bash
docker compose --profile chat up -d --force-recreate openwebui
docker compose logs openwebui --tail=30
# Verify cert mount:
docker exec ragstack-openwebui ls -la /opt/onemcp-ca.crt
```

### 4. Test Function/Action từ OpenWebUI Admin

Mở `http://<onelog-source-ip>:8090`, login admin.

**Function `onemcp_search`:**
- Admin → Workspace → Functions → **Import** (hoặc **+ New Function**)
- Paste nội dung `functions/onemcp-tools.py`
- Save → toggle **Enabled**
- Set Valves nếu cần (default ONEMCP_URL=https://192.168.122.56, ONEMCP_CA_PATH=/opt/onemcp-ca.crt)

**Action `onemcp-submit-kb`:**
- Admin → Workspace → **Actions** → + New Action (hoặc Import)
- Paste nội dung `actions/onemcp-submit-kb.py`
- Save → toggle **Enabled**
- Set Valves: LITELLM_API_KEY (có thể reuse OPENWEBUI_LITELLM_VIRTUAL_KEY)

**Verify import + reachability:**
```bash
# Từ openwebui container, test call OneMCP
docker exec ragstack-openwebui curl -sS \
  --cacert /opt/onemcp-ca.crt \
  -H "X-Onemcp-User: openwebui-bot" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  https://192.168.122.56/api/mcp | head -c 500
# → JSON với result.tools = 8 tools
```

### 5. Apply system prompt

Admin → Settings → Interface → **Default System Prompt** → paste block trong `system-prompt-ops.md`.

Hoặc per-model override cho DeepSeek: Admin → Models → deepseek → System Prompt.

Test:
- Chat mới: hỏi "test onemcp" → LLM có gọi `onemcp_search` không?
- Chat error: "nginx 502 spike" → LLM sinh 2-3 query variants?

### 6. Alertmanager webhook (Phase 4)

Sau khi apply `infra/alertmanager/*` changes (xem file config), reload:
```bash
docker compose kill -s HUP alertmanager
```

## Rollback

**Disable Function/Action** (5s):
- Admin → Workspace → Functions → toggle OFF
- Admin → Workspace → Actions → toggle OFF

**Full revert**:
```bash
cd /home/vietnt/onelog
git checkout HEAD~1 -- infra/docker-compose.yml infra/openwebui/
docker compose --profile chat up -d --force-recreate openwebui
docker compose kill -s HUP alertmanager
```

## Test suite local

Trước khi deploy, chạy unit tests redact:
```powershell
cd d:/Vietnt/Project/onelog/infra/openwebui/actions
python -m pytest test_redact.py -v
# Hoặc manual smoke (nếu không có pytest):
python -c "from redact import redact; print(redact('nginx 502').text)"
```

## Troubleshooting

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| Function trả `OneMCP unreachable` | onelog-source không route tới 192.168.122.56 | Verify: `ping 192.168.122.56` từ host + `curl -k https://192.168.122.56/health` |
| `SSL: CERTIFICATE_VERIFY_FAILED` | Cert path Valve sai hoặc cert stale | Verify mount: `docker exec ragstack-openwebui cat /opt/onemcp-ca.crt \| head -3` |
| `403 Forbidden` từ OneMCP | Bot user chưa được whitelist trong CIDR OneMCP | SSH OneMCP host → sửa USER_ALLOW_CIDR trong .env → restart nginx |
| Action button không xuất hiện | Action chưa Enable hoặc OpenWebUI version quá cũ | Admin → Actions → Enable + check version ≥ 0.10 |
| Modal preview không hiện, submit direct | OpenWebUI 0.10.2 không support `__event_call__ type:input` | Chấp nhận (V1 fallback) hoặc upgrade OpenWebUI |
