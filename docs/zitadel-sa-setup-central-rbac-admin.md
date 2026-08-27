# Zitadel SA setup — central-rbac-admin

Runbook để anh setup Zitadel service account cho Phase 07 admin wizard (`POST /v1/admin/apps`).

**Plan ref:** [phase-07-admin-wizard.md § Step 1](../plans/260826-1644-central-rbac-hardening-and-self-service/phase-07-admin-wizard.md)
**Validation ref:** [plan.md § Validation Log Decision 4](../plans/260826-1644-central-rbac-hardening-and-self-service/plan.md)

## Golden rules

- **KHÔNG** dùng chung SA với Phase 06 SAs (`central-rbac-webhook`, `onemcp-backend`, `portal-admin`)
- SA này **CÓ IAM_OWNER** — high blast radius. Compensating controls MUST all be in place before use
- Sau khi tạo PAT, paste ngay vào `.env` trên VPS + shred bản local
- Rotate MONTHLY (không quý per plan validation)

## 1. Tạo SA trong Zitadel console

**Đường dẫn:** http://10.200.0.125/ → Login admin → **Users** → **Service Users**

1. Bấm **+ New**
2. `Login Name`: `central-rbac-admin-sa`
3. `Display Name`: `Central RBAC Admin SA (wizard)`
4. Access token type: **Bearer**
5. Bấm **Save**

## 2. Grant IAM_OWNER

**Đường dẫn:** Settings → **IAM Members**

1. Bấm **+ Add Member**
2. Search: `central-rbac-admin-sa` → chọn
3. Role: **IAM_OWNER** (accept warning về blast radius)
4. Bấm **Save**

## 3. Generate PAT (Personal Access Token)

**Đường dẫn:** Users → Service Users → `central-rbac-admin-sa` → **Personal Access Tokens** tab

1. Bấm **+ New**
2. Expiration: **30 ngày** (rotate monthly per Fix #4)
3. Bấm **Create** → **COPY PAT NGAY** (hiện 1 lần)
4. Paste sang Bitwarden trước khi làm bước 4

## 4. Paste PAT vào VPS `.env`

```bash
ssh authway-vps

# Edit env file
cd /opt/central-rbac
# Append to .env:
cat >> .env <<'EOF'

# Phase 07 admin wizard (2026-08-27)
ZITADEL_SA_PAT=<paste PAT ở đây>
ZITADEL_ORG_ID=<snowflake ID của org — copy từ URL khi ở Organizations page>
RATE_LIMIT_ADMIN_APP_CREATE_PER_ADMIN=5
RATE_LIMIT_ADMIN_APP_CREATE_GLOBAL=20
EOF

# Verify no plaintext PAT lộ ra
grep -c ZITADEL_SA_PAT .env  # expect 1

# Restart central-rbac để pick up env mới
docker compose -f docker-compose.prod.yml restart central-rbac
sleep 8

# Verify wizard endpoint từ chối token invalid (không phải "ZITADEL_SA_PAT not configured")
curl -sX POST http://10.200.0.125:8082/v1/admin/apps \
  -H "Authorization: Bearer fake" \
  -H "Content-Type: application/json" \
  -d '{}'
# Expect: {"error":"Invalid token"} (JWT verify fails, means SA_PAT env exists)
```

## 5. Hardening — Zitadel IP allowlist (Fix #4)

**Đường dẫn:** Users → Service Users → `central-rbac-admin-sa` → **Personal Access Tokens** → PAT settings

- Zitadel v4.16.1 KHÔNG hỗ trợ per-PAT IP allowlist native
- Workaround: bật audit alarm at Zitadel-side (rule sau)

**Alternative:** Zitadel Actions v2 → xét source_ip trong pre-mgmt-call hook → reject nếu không phải `10.200.0.125`. Documented as TODO, không blocking.

## 6. Hardening — inotify monitoring `/root/.secrets/*.json`

```bash
ssh authway-vps

# Install inotify-tools if missing
apt-get install -y inotify-tools

# Systemd path unit: alert on any read of PAT file
cat > /etc/systemd/system/rbac-sa-pat-watch.path <<'EOF'
[Unit]
Description=Watch central-rbac SA PAT file for unexpected access

[Path]
PathModified=/opt/central-rbac/.env

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/rbac-sa-pat-watch.service <<'EOF'
[Unit]
Description=Alert on central-rbac SA PAT modification

[Service]
Type=oneshot
ExecStart=/usr/local/bin/alert-sa-pat-change.sh
EOF

cat > /usr/local/bin/alert-sa-pat-change.sh <<'EOF'
#!/bin/bash
curl -sX POST -H 'Content-Type: application/json' \
  -d '[{"labels":{"alertname":"CentralRbacSaPatModified","severity":"warning"},"annotations":{"summary":"/opt/central-rbac/.env modified — verify rotation was intentional"}}]' \
  http://alertmanager:9093/api/v2/alerts
EOF
chmod +x /usr/local/bin/alert-sa-pat-change.sh

systemctl daemon-reload
systemctl enable --now rbac-sa-pat-watch.path
```

## 7. Hardening — Zitadel-side audit alarm on IAM_OWNER usage

**Đường dẫn:** Zitadel Console → Actions → **Triggers** → **PostAuthentication** hoặc **PreEvent**

- Trigger action khi `sub` = `central-rbac-admin-sa`
- Log source IP; nếu != `10.200.0.125` → send webhook to Alertmanager

Placeholder skeleton (điều chỉnh tuỳ Zitadel Actions v2 API):

```javascript
// Zitadel Action script (JS runtime)
function preManagementCall(ctx, api) {
  if (ctx.subject === "central-rbac-admin-sa") {
    const sourceIp = ctx.metadata.source_ip;
    if (sourceIp !== "10.200.0.125") {
      api.postWebhook("http://alertmanager:9093/api/v2/alerts", [{
        labels: { alertname: "ZitadelSaFromUnknownIp", severity: "critical" },
        annotations: {
          summary: "central-rbac-admin-sa called Mgmt API from " + sourceIp,
        },
      }]);
    }
  }
}
```

## 8. Monthly rotation runbook

Đầu tháng (chậm nhất ngày 5):

```bash
# 1. Generate PAT mới (bước 3), copy sang Bitwarden
# 2. Update /opt/central-rbac/.env với PAT mới
# 3. docker compose restart central-rbac
# 4. Verify /v1/admin/apps still works
# 5. Delete PAT cũ trong Zitadel Console (Users → SA → PATs → Delete)
# 6. Update Bitwarden note: version bump + expiry date mới
```

## Verify SA setup complete

- [ ] SA `central-rbac-admin-sa` visible trong Zitadel Users → Service Users
- [ ] IAM_OWNER member trong Settings → IAM Members
- [ ] PAT generated + saved to Bitwarden với expiry note
- [ ] `.env` VPS chứa `ZITADEL_SA_PAT` + `ZITADEL_ORG_ID`
- [ ] `docker compose restart central-rbac` + logs không error
- [ ] `curl /v1/admin/apps` từ chối "Invalid token" (không phải "SA_PAT not configured")
- [ ] inotify path unit `rbac-sa-pat-watch.path` active
- [ ] Zitadel Action alarm on IAM_OWNER usage (nếu Actions v2 sẵn sàng)
- [ ] Calendar reminder: rotate ngày 5 tháng sau

## Unresolved

- Zitadel v4.16.1 KHÔNG có native per-PAT IP allowlist → chỉ có detect-only alarm
- Zitadel Actions v2 API cho pre-Mgmt-call hook chưa verify — có thể cần polling audit log qua Loki thay thế
- inotify path unit rely on Alertmanager reachable — nếu AM down + PAT compromise: silent alarm gap
