# Phase 01 · Grafana container + Caddy admin subdomain

## Context
- Plan: [../plan.md](../plan.md)
- Mockup: [../../mockups/onelog-cost-dashboard.html](../../mockups/onelog-cost-dashboard.html)
- Access model (đã chốt): subdomain `admin.webui.local` · strict CIDR · bearer · Grafana login

## Overview
- Priority: HIGH · blocks Phase 02, 03, 04
- Foundation: đưa Grafana lên trong compose, cấu hình VictoriaLogs datasource, expose qua Caddy admin subdomain với 3 lớp bảo vệ.

## Key insights
- OneLog dùng Caddy sẵn có (không nginx). Reuse block pattern hiện tại.
- Grafana bind loopback `127.0.0.1:3000`, chỉ đi qua Caddy — không expose thẳng LAN.
- VictoriaLogs Grafana plugin native từ v10+ (grafana-victoriametrics-datasource). Đủ cho LogsQL.
- OpenWebUI dùng port 8080 → 8090 mapping, không đụng.
- Profile mới `dashboard` opt-in — không auto-start với default deploy.

## Requirements

### Functional
- Grafana lên tại `http://127.0.0.1:3000` (bind loopback)
- `admin.webui.local` route qua Caddy → Grafana (LAN internal DNS map)
- Admin panel access cần: (1) IP trong `ADMIN_STRICT_CIDR`, (2) Bearer `COST_DASHBOARD_TOKEN`, (3) Grafana login
- VictoriaLogs datasource pre-provisioned (URL `http://victorialogs:9428`)
- Data persist qua volume bind `./data/grafana`

### Non-functional
- Zero downtime với chat flow (`webui.local` không đổi)
- Grafana anonymous access disabled
- Signup disabled (invite-only)
- Bootstrap admin qua env var lần đầu, sau đó unset

## Architecture

```
LAN (192.168.122.0/24)                      LAN admin subnet (2 máy)
  browser → http://webui.local              browser → http://admin.webui.local
        │                                          │
        │                                          │ (strict CIDR + Bearer)
        ▼                                          ▼
   Caddy :80 ──────────────────────────► Grafana :3000 (loopback)
        │                                          │
        └─► openwebui :8080                        └─► VictoriaLogs :9428 (datasource)
```

## Related files

### Modify
- `infra/docker-compose.yml` — thêm service `grafana` (profile `dashboard`)
- `infra/caddy/Caddyfile` — thêm block `admin.webui.local`
- `infra/.env.example` — thêm 3 biến mới
- `infra/.env` — set giá trị thật (không commit)

### Create
- `infra/grafana/grafana.ini` — disable anonymous, disable signup, session settings
- `infra/grafana/provisioning/datasources/victorialogs.yml` — pre-provision VL datasource
- `infra/grafana/provisioning/dashboards/dashboards.yml` — pre-provision dashboard folder
- `infra/data/grafana/` — volume bind directory (gitignore)

### Reference (read-only)
- `infra/docker-compose.yml` line 478-513 (Caddy block hiện tại) — copy pattern
- `infra/caddy/Caddyfile` — hiểu ADMIN_ALLOW_CIDR usage

## Implementation steps

1. **Grafana config files** (`infra/grafana/`):
   - `grafana.ini`:
     ```ini
     [auth.anonymous]
     enabled = false
     [users]
     allow_sign_up = false
     [security]
     admin_user = admin
     admin_password = $__env{GRAFANA_ADMIN_PASSWORD}
     [server]
     root_url = http://admin.webui.local/
     ```
   - `provisioning/datasources/victorialogs.yml`:
     ```yaml
     apiVersion: 1
     datasources:
       - name: VictoriaLogs
         type: victoriametrics-logs-datasource
         url: http://victorialogs:9428
         access: proxy
         isDefault: true
     ```
   - `provisioning/dashboards/dashboards.yml` (file provider, load JSON từ `/etc/grafana/dashboards/`)

2. **docker-compose.yml** — thêm service `grafana`:
   ```yaml
   grafana:
     image: grafana/grafana-oss:11-slim
     container_name: ragstack-grafana
     restart: unless-stopped
     profiles: [dashboard]
     ports:
       - "127.0.0.1:3000:3000"
     volumes:
       - ./grafana/grafana.ini:/etc/grafana/grafana.ini:ro
       - ./grafana/provisioning:/etc/grafana/provisioning:ro
       - ./grafana/dashboards:/etc/grafana/dashboards:ro
       - ./data/grafana:/var/lib/grafana
     environment:
       GF_INSTALL_PLUGINS: victoriametrics-logs-datasource
       GRAFANA_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD}
     depends_on:
       - victorialogs
   ```

3. **Caddyfile** — thêm block:
   ```caddy
   admin.webui.local {
     @admin_lan remote_ip {$ADMIN_STRICT_CIDR}
     @has_token header Authorization "Bearer {$COST_DASHBOARD_TOKEN}"
     handle @admin_lan {
       handle @has_token {
         reverse_proxy grafana:3000
       }
       respond "Unauthorized — Bearer token required" 401
     }
     respond "Forbidden — IP not in admin CIDR" 403
   }
   ```

4. **.env.example** — append:
   ```env
   # Phase 260709-1143 · Cost Dashboard
   ADMIN_STRICT_CIDR=192.168.122.10/32,192.168.122.11/32
   COST_DASHBOARD_TOKEN=CHANGE_ME_openssl_rand_hex_24
   GRAFANA_ADMIN_PASSWORD=CHANGE_ME_STRONG
   ```

5. **DNS/hosts** — trên 2 máy admin thêm `/etc/hosts`:
   ```
   192.168.122.53  admin.webui.local
   ```
   (hoặc lab DNS internal nếu có)

6. **Bring up**:
   ```bash
   cd ~/onelog/infra
   docker compose --profile dashboard up -d grafana
   docker compose logs -f grafana | grep -i 'HTTP Server Listen'
   ```

7. **Verify access**:
   ```bash
   # Từ máy admin trong strict CIDR
   curl -H "Authorization: Bearer $COST_DASHBOARD_TOKEN" \
        http://admin.webui.local/api/health
   # → 200 {"database":"ok"}

   # Từ máy khác trong LAN (không strict CIDR)
   curl http://admin.webui.local/  # → 403
   ```

## Todo list

- [ ] Create `infra/grafana/grafana.ini`
- [ ] Create `infra/grafana/provisioning/datasources/victorialogs.yml`
- [ ] Create `infra/grafana/provisioning/dashboards/dashboards.yml`
- [ ] Add `grafana` service to `docker-compose.yml` with profile `dashboard`
- [ ] Add `admin.webui.local` block to `Caddyfile`
- [ ] Append 3 new vars to `.env.example`
- [ ] Set real values in `.env` (openssl rand cho token + password)
- [ ] Update `.gitignore` — add `infra/data/grafana/` nếu chưa cover
- [ ] Add `admin.webui.local` vào `/etc/hosts` của 2 máy admin
- [ ] `docker compose --profile dashboard up -d grafana`
- [ ] Verify Grafana health endpoint qua bearer
- [ ] Verify 403 khi IP ngoài strict CIDR
- [ ] Login Grafana web, đổi password admin bootstrap
- [ ] Confirm VictoriaLogs datasource "Test" → OK

## Success criteria
- Grafana container healthy, restart on reboot
- `curl http://admin.webui.local/` từ máy admin có bearer → 200
- `curl http://admin.webui.local/` từ máy LAN không strict CIDR → 403
- `curl http://admin.webui.local/` từ máy admin không bearer → 401
- Grafana UI → Datasources → VictoriaLogs "Test" pass
- `dc ps` show grafana `Up (healthy)`
- Chat `webui.local` vẫn hoạt động bình thường (regression check)

## Risk assessment

| Risk | Mitigation |
|---|---|
| Caddy reload fail do syntax admin.webui.local block | `caddy validate --config Caddyfile` trước khi reload |
| VictoriaLogs plugin không install được offline | Pre-pull image `grafana/grafana-oss:11-slim` với plugin sẵn (build custom) hoặc cho phép egress lần đầu |
| Grafana admin password leak trong compose stdout | Dùng `env_file` hoặc reference `${VAR}`, không hardcode |
| Port 3000 conflict với service khác | `ss -tlnp \| grep 3000` check trước · bind `127.0.0.1` only |

## Security considerations

- `COST_DASHBOARD_TOKEN` = độc lập với MCP tokens · LiteLLM master · rotate 90d
- `GRAFANA_ADMIN_PASSWORD` = strong (openssl rand 32 chars) · thay ngay sau bootstrap
- Không mở port 3000 ra LAN — chỉ Caddy relay
- `admin.webui.local` DNS chỉ ánh xạ trên máy admin — máy chat không resolve được
- Session cookie Grafana `secure=true` khi có HTTPS (lab HTTP thì skip)

## Next steps
- Phase 02: Import 4 panel LogsQL quick-win
- Phase 03 (parallel): script poll provider balance
