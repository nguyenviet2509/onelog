# LLM Cost Dashboard — Runbook

## TL;DR

Dashboard để xem cost + quota realtime từ 4 LLM provider (Anthropic, OpenAI, DeepSeek, Gemini). Deploy Phase A (Grafana + LogsQL panels) trong ~5 phút. Phase B (provider API poll) thêm 15 phút nữa khi có admin key.

Xem mockup: [onelog-cost-dashboard.html](../mockups/onelog-cost-dashboard.html)

---

## Golden rules

1. **Dashboard opt-in profile** — `docker compose --profile dashboard` phải được cấp để Grafana start. Không enable mặc định.
2. **Admin subdomain riêng** — `admin.webui.local` (strict CIDR + Bearer token + Grafana login), không share với `webui.local` (team chat).
3. **Admin API key riêng** — OpenAI/Anthropic dùng key admin cấp cao riêng, **không phải** key dùng cho LiteLLM proxy.
4. **Rotate 90 ngày** — Admin key cấp cao dễ leak; setup cron + calendar reminder.
5. **chmod 0400** — Tệp `.env.cost` (admin keys) phải root-only, không share được.

---

## Kiến trúc 2 nguồn data

```
┌─────────────────────────────────────────────────────────────┐
│ LiteLLM logs (realtime)       │ Provider APIs (poll 15m)      │
├─────────────────────────────────────────────────────────────┤
│ • Per-request cost (Anthropic, OpenAI, DeepSeek, Gemini)   │
│ • Per-user 7d spend            │ • DeepSeek balance          │
│ • Fallback event 24h           │ • OpenAI monthly spend      │
│                                │ • Anthropic cache usage     │
│ → Vector → VictoriaLogs        │ → poll-provider-cost.sh     │
│            (realtime)          │    (syslog) → VictoriaLogs  │
│            ↓                   │           (15m delay)       │
│         Grafana (cross-check panels) ← admin.webui.local    │
└─────────────────────────────────────────────────────────────┘
```

---

## Quick deploy — Phase A (Grafana + LogsQL)

**Prerequisites**: Phase 01-02 hoàn thành (Grafana + VictoriaLogs datasource ready).

Copy-paste trên `logserver`:

```bash
# 1. Gen secrets
COST_TOKEN=$(openssl rand -hex 24)
GRAFANA_PW=$(openssl rand -base64 24)
echo "COST_DASHBOARD_TOKEN=$COST_TOKEN"
echo "GRAFANA_ADMIN_PASSWORD=$GRAFANA_PW"

# 2. Paste vào .env
vi ~/onelog/infra/.env
# Thêm:
#   ADMIN_STRICT_CIDR=192.168.122.10/32,192.168.122.11/32  (chỉ admin IP)
#   COST_DASHBOARD_TOKEN=<paste từ trên>
#   GRAFANA_ADMIN_PASSWORD=<paste từ trên>

# 3. Chuẩn bị data dir
mkdir -p ~/onelog/infra/data/grafana
sudo chown 472:472 ~/onelog/infra/data/grafana

# 4. Bring up Grafana
cd ~/onelog/infra
docker compose --profile dashboard pull
docker compose --profile dashboard up -d grafana
sleep 10
docker compose --profile dashboard ps grafana

# 5. (Optional Phase B) Poll provider balance
# Chi tiết ở section "Phase B" dưới
```

**Verify**: `curl -H "Authorization: Bearer $COST_TOKEN" http://admin.webui.local/` → Caddy prompt login Grafana.

---

## Config .env block

| Var | Format | Purpose | Example |
|---|---|---|---|
| `ADMIN_STRICT_CIDR` | CIDR list | IP restrict admin.webui.local | `192.168.122.10/32,192.168.122.11/32` |
| `COST_DASHBOARD_TOKEN` | Bearer hex | Caddy pre-auth | `sk-cost-abc123def456...` |
| `GRAFANA_ADMIN_PASSWORD` | Base64 | Bootstrap Grafana admin | `MyStr0ng!Pass` |
| `COST_ALERT_DEEPSEEK_BALANCE_MIN` | $ USD | Alert when < this | `5` |
| `COST_ALERT_OPENAI_DAILY_MAX` | $ USD | Alert when daily > | `3` |
| `COST_ALERT_ANTHROPIC_MONTHLY_SOFT` | $ USD | Alert when monthly > | `14` |
| `COST_ALERT_USER_DAILY_MAX` | $ USD | Alert per user per day | `2` |

---

## Access dashboard

```bash
# Via browser (từ admin CIDR machine)
http://admin.webui.local/

# Prompt → paste COST_DASHBOARD_TOKEN value (without "Bearer " prefix if Caddy asks)
# Then → Grafana login: admin / $GRAFANA_ADMIN_PASSWORD
# Then → Change admin password immediately (UI top-right → Change Password)

# Via curl (test)
curl -H "Authorization: Bearer $COST_DASHBOARD_TOKEN" \
  -u admin:$GRAFANA_ADMIN_PASSWORD \
  http://admin.webui.local/api/health
# → {"commit":"","database":"ok","version":"11.0.0"}
```

---

## Phase B — Provider admin API key rotation (90d SOP)

**Prerequisite**: admin keys từ OpenAI + Anthropic (đã có trước).

```bash
# 1. Create new provider dashboard
#    OpenAI: https://platform.openai.com/account/billing/limits
#    Anthropic: https://console.anthropic.com/account/billing/limits

# 2. Prepare .env.cost
cp ~/onelog/infra/litellm/.env.cost.example ~/onelog/infra/litellm/.env.cost
sudo chown root:root ~/onelog/infra/litellm/.env.cost
sudo chmod 0400 ~/onelog/infra/litellm/.env.cost

# 3. Edit (as root, or sudo vi)
sudo vi ~/onelog/infra/litellm/.env.cost
# Paste real admin keys:
#   OPENAI_ADMIN_KEY=<api-key>
#   ANTHROPIC_ADMIN_KEY=<api-key>
#   DEEPSEEK_ADMIN_KEY=<api-key>

# 4. Test script manually
sudo bash ~/onelog/infra/scripts/poll-provider-cost.sh
# → Logs appear in /var/log/onelog-provider-cost.log

# 5. Setup cron (runs as root every 15 min)
sudo crontab -e
# Add: */15 * * * * bash /root/onelog/infra/scripts/poll-provider-cost.sh \
#   >> /var/log/onelog-provider-cost.log 2>&1

# 6. Verify cron picked it up
sudo crontab -l | grep poll-provider-cost

# 7. (Optional) Reload Vector to pick up new transforms
docker compose kill -s HUP vector
```

**Rotate (every 90 days)**:
- Create new admin key in provider console
- Update `.env.cost` with new key
- `sudo chmod 0400` again
- Test script manually
- Revoke old key in provider console

---

## Add / edit Grafana panel

Grafana dashboards saved as JSON → Git:

```bash
# 1. Edit panel in Grafana UI (admin.webui.local/d/llm-cost-overview)
# 2. Dashboard → Dashboard settings → JSON model
# 3. Copy JSON to file
cp ~/onelog/infra/grafana/dashboards/llm-cost-overview.json \
   ~/onelog/infra/grafana/dashboards/llm-cost-overview.json.backup

# 4. Paste edited JSON
vi ~/onelog/infra/grafana/dashboards/llm-cost-overview.json

# 5. Force Grafana reload dashboard
docker compose --profile dashboard restart grafana
docker compose --profile dashboard logs -f grafana | head -20
# Watch for "Dashboard ... provisioned successfully"
```

---

## Tune alert threshold

Alerts fire from vmalert, watch by provider cost rule group. Two approaches:

**Approach 1: Edit .env** (persist across restarts)
```bash
vi ~/onelog/infra/.env
# Adjust COST_ALERT_* vars, then:
docker compose kill -s HUP vmalert
```

**Approach 2: Edit rules directly** (manual tweaks)
```bash
vi ~/onelog/infra/vmalert/rules.yml
# Find section: "llm_cost" rule group
# Edit filter conditions: "balance:$<5" → "balance:$<10" etc
docker compose restart vmalert
```

Baseline: observe 1 week, set threshold = 2 × p95 of normal spend.

---

## Disable Gemini estimate (hide panel)

Google Gemini has no cost API. Dashboard shows LiteLLM pricing estimate only.

To hide:
```bash
# 1. Open dashboard Grafana UI
# 2. Find "Gemini Monthly" panel
# 3. Panel options → Visibility → Hide
# 4. Dashboard → Save
```

---

## Troubleshooting

| Symptom | Root cause | Fix |
|---|---|---|
| Panel empty sau restart Grafana | Provisioning fail hoặc datasource UID wrong | `docker compose logs grafana \| grep -i error` · verify `victorialogs.yml` datasource UID = `victorialogs` |
| Provider cost stream trống | Cron chưa chạy hoặc ENV_FILE path sai | `sudo crontab -l` verify entry exists · `sudo bash poll-provider-cost.sh` manual test · check `/var/log/onelog-provider-cost.log` |
| Alert không tới Telegram | Alertmanager routing sai hoặc bot token invalid | `docker compose logs alertmanager \| head -30` · test: `amtool alert add TestAlert severity=critical` |
| Admin key expire (401 in poll log) | Key revoked provider-side hoặc rotated không update | Re-run Phase B rotation steps · verify `sudo cat /root/onelog/infra/litellm/.env.cost` has new key |
| Grafana bootstrap password quên | Password lost after restart | `docker compose exec grafana grafana-cli admin reset-admin-password <new-pw>` |
| admin.webui.local → 403 Forbidden | Client IP not in ADMIN_STRICT_CIDR | Check `ADMIN_STRICT_CIDR` in `.env` · whitelist client machine IP/32 |

---

## Rollback

```bash
# Option 1: Stop Grafana only
docker compose --profile dashboard down grafana

# Option 2: Full disable — remove cost dashboard
docker compose --profile dashboard down
vi ~/onelog/infra/Caddyfile
# Delete/comment the "admin.webui.local" block

# Option 3: Remove cron
sudo crontab -e
# Delete poll-provider-cost line
```

---

## Cross-refs

- **Plan**: [plan.md](../plans/260709-1143-onelog-cost-dashboard/plan.md)
- **Mockup**: [onelog-cost-dashboard.html](../mockups/onelog-cost-dashboard.html)
- **Grafana config**: [infra/grafana/](../infra/grafana/)
- **Poll script**: [infra/scripts/poll-provider-cost.sh](../infra/scripts/poll-provider-cost.sh)
- **Alert rules**: [infra/vmalert/rules.yml](../infra/vmalert/rules.yml) (llm_cost group)
- **Deployment guide**: [deployment-guide.md](deployment-guide.md) → "Optional · Cost dashboard" section
