# LLM Provider — admin ops guide

> Audience: ops admin quản lý LiteLLM proxy + OpenWebUI.
> Deploy trước theo [deployment-llm-abstraction.md](deployment-llm-abstraction.md).

## Golden rules

1. `docker compose` **luôn từ `~/onelog/infra`**.
2. Master key = ROOT — leak = full access mọi provider. Rotate nếu nghi ngờ.
3. Provider keys ở 2 nơi tách biệt: `.env` (agent, LiteLLM SDK) + `.env.llm` (proxy, chmod 0400).
4. Runtime add/delete model **không** cần restart — dùng `/model/new` + `/model/delete`.

---

## Stack overview

```
Browser (5 ops)
    ↓ http://webui.local
Caddy ─→ openwebui ─→ litellm-proxy ─→ Anthropic / OpenAI / Gemini / DeepSeek
                                    ↓
                          stdout JSON (cost log)
                                    ↓
                            VictoriaLogs
```

Agent (`/chat` endpoint) dùng LiteLLM SDK **trực tiếp** — không qua proxy.

## Provider key rotation

**Khi nào:** quarterly, khi member nghỉ, khi nghi leak.

```bash
cd ~/onelog/infra

# 1. Sinh key mới ở provider dashboard (Anthropic console / OpenAI / Google AI Studio / DeepSeek)

# 2. Update .env.llm (cho proxy)
sudo vi litellm/.env.llm    # thay 1 key

# 3. Update .env (cho agent)
vi .env                     # thay cùng key

# 4. Restart 2 service
docker compose --profile llm --profile chat restart litellm-proxy
docker compose --profile agent restart agent

# 5. Verify không error
docker compose logs --tail=30 litellm-proxy | grep -iE 'error|401|invalid'
docker compose logs --tail=30 agent | grep -iE 'error|401'

# 6. Smoke test
export LITELLM_MASTER_KEY=$(grep '^LITELLM_MASTER_KEY=' .env | cut -d= -f2)
curl -fsS -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-flash","messages":[{"role":"user","content":"ping"}]}' | jq '.choices[0].message.content'

# 7. Revoke key cũ ở provider dashboard
```

## Kill-switch runtime (disable 1 provider nhanh)

**Use case:** key leak, provider outage, cost spike.

```bash
export LITELLM_MASTER_KEY=$(grep '^LITELLM_MASTER_KEY=' .env | cut -d= -f2)

# Disable gemini-flash ngay — fallback tự route
curl -X POST http://localhost:4000/model/delete \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model_name":"gemini-flash"}'

# Verify chỉ còn 3 model
curl -fsS http://localhost:4000/v1/models -H "Authorization: Bearer $LITELLM_MASTER_KEY" | jq '.data[].id'
```

Re-add sau khi rotate:

```bash
curl -X POST http://localhost:4000/model/new \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model_name": "gemini-flash",
    "litellm_params": {
      "model": "gemini/gemini-2.5-flash",
      "api_key": "os.environ/GEMINI_API_KEY"
    }
  }'
```

**Fallback verify:** sau khi disable primary, gọi `/v1/chat/completions` với `model:"gemini-flash"` — LiteLLM trả 200 nhưng log chỉ ra fallback đã trigger.

## Thêm provider mới

Vd thêm Mistral:

1. Sửa `infra/litellm/config.yaml`:
   ```yaml
   model_list:
     - model_name: mistral-large
       litellm_params:
         model: mistral/mistral-large-latest
         api_key: os.environ/MISTRAL_API_KEY
   ```
2. Thêm `MISTRAL_API_KEY=...` vào `litellm/.env.llm`.
3. `docker compose --profile llm restart litellm-proxy`.
4. Verify: `curl /v1/models | jq` — có `mistral-large`.
5. (Optional) Thêm vào fallback chain trong `router_settings.fallbacks`.
6. Cập nhật virtual key permission nếu OpenWebUI dùng key riêng.

## Xem cost breakdown

Không có Postgres backend → cost log qua stdout JSON, tail vào VictoriaLogs:

```bash
# Tail live
docker compose logs -f litellm-proxy | grep -E 'spend|cost'

# Query VictoriaLogs (nếu đã wire log driver)
curl -fsS "http://localhost:9428/select/logsql/query" \
  -d 'query=service:"litellm-proxy" AND event:"cost"' | jq

# Cost by model, last 24h
curl -fsS "http://localhost:9428/select/logsql/query" \
  -d 'query=service:"litellm-proxy" AND _time:1d | stats by (model) sum(spend)' | jq
```

## Budget alert (500K VND/tháng)

Check thủ công weekly:
```bash
# Sum cost tháng hiện tại (USD → VND ~24000)
docker compose logs --since 30d litellm-proxy \
  | grep '"event":"cost"' \
  | jq -s 'map(.spend) | add' \
  | awk '{printf "Tổng: $%.2f = %d VND\n", $1, $1*24000}'
```

**Threshold:**
- **80%** (~400K VND) → nhắn Slack team, xem xét switch default sang `gemini-flash`.
- **100%** (~500K VND) → kill-switch model đắt nhất (`claude-sonnet`), báo team.

## Model switching (đổi default)

Đổi model mặc định của agent (không cần rebuild image):

```bash
cd ~/onelog/infra
vi .env
# LLM_MODEL=gemini/gemini-2.5-flash   # <── đổi ở đây
# LLM_FALLBACK_MODELS=openai/gpt-4.1-mini,anthropic/claude-sonnet-4-5

docker compose --profile agent restart agent

# Smoke test
curl -fsS http://localhost:8080/health && echo " OK"
```

Đổi default OpenWebUI: user tự chọn trong UI, hoặc admin set env `DEFAULT_MODELS` cho openwebui service rồi restart.

## Postgres schema (deferred)

**Hiện tại disabled** — LiteLLM chạy in-memory, cost log qua stdout. Không có persistent budget tracking.

Nếu cần enable sau (khi ≥ 50 user hoặc budget tracking bắt buộc):

1. Tạo schema riêng:
   ```sql
   -- Trong postgres container
   CREATE SCHEMA litellm;
   CREATE USER litellm WITH PASSWORD '<random>';
   GRANT ALL ON SCHEMA litellm TO litellm;
   ALTER USER litellm SET search_path TO litellm;
   ```
2. Uncomment `database_url` + `STORE_MODEL_IN_DB` trong `docker-compose.yml` LiteLLM service.
3. `docker compose --profile llm up -d litellm-proxy` — chờ Prisma migrate (5-10 phút first run).
4. **Cảnh báo:** Prisma **ignore** search_path trong URL — sẽ tạo table vào `public` gây collision. Chỉ enable khi có db riêng cho LiteLLM hoặc chấp nhận namespace conflict.

Rollback triệt để:
```sql
DROP SCHEMA litellm CASCADE;
```

## Backup

Chat history + workspace + user settings ở volume `openwebui_data`:

```bash
# Manual backup
sudo ~/onelog/infra/scripts/backup-openwebui.sh

# Cron (đã cài):
# 0 3 * * * /home/deploy/onelog/infra/scripts/backup-openwebui.sh

# Verify backup file
ls -lh ~/onelog/backups/openwebui/
```

Backup file `.tgz.age` encrypt bằng age. Recipient public key ở `~/.age/openwebui-backup.pub`. Private key giữ offsite (không commit).

**Restore:**
```bash
age -d -i ~/.age/openwebui-backup.key backup-2026-07-15.tgz.age > backup.tgz
docker compose --profile chat stop openwebui
docker run --rm -v onelog_openwebui_data:/data -v $PWD:/backup alpine \
  sh -c 'cd /data && tar xzf /backup/backup.tgz'
docker compose --profile chat start openwebui
```

## Troubleshooting

| Triệu chứng | Fix |
|---|---|
| Fallback không trigger khi primary fail | Check `config.yaml` `router_settings.fallbacks` — model name phải khớp `model_list[*].model_name` |
| `/spend/logs` empty | Không có DB backend — dùng stdout log qua `docker compose logs` |
| OpenWebUI model list rỗng | Virtual key null / hết budget → set `OPENWEBUI_LITELLM_VIRTUAL_KEY=${LITELLM_MASTER_KEY}` trong `.env`, restart openwebui |
| Model timeout > 25s | LiteLLM timeout = 25s (< agent 30s). Nếu provider quá chậm, tăng cả 2 (nhớ giữ litellm < agent) |
| `429 rate limit` liên tục | Kill-switch model đó, hoặc contact provider tăng quota |
| MCP tools không show trong OpenWebUI | `docker exec openwebui cat /app/backend/data/mcp-config.json` — check `MCP_TOKEN_OPENWEBUI` khớp `.env` |
| Cost log không tail vào VictoriaLogs | Verify docker log driver `fluentd`/`journald` wire vào VL. Fallback: cron script grep + POST vào VL API |

## Escalation

- Provider account issue → contact provider support (Anthropic / OpenAI / Google / DeepSeek dashboard).
- Master key leak nghi ngờ → immediate rotate + audit `docker compose logs litellm-proxy` grep IP nguồn call.
- Budget vượt bất thường (>2x normal) → kill-switch expensive model + investigate: user compromised? runaway agent loop?

Xem thêm: [deployment-llm-abstraction.md](deployment-llm-abstraction.md) · [openwebui-user-guide.md](openwebui-user-guide.md).
