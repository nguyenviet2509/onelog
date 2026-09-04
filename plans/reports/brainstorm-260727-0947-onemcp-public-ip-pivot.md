# OneMCP Public IP Pivot — bỏ CIDR, SSO-only auth

**Date:** 2026-07-27
**Status:** Design agreed — impacts existing SSO plan `260727-0843-onemcp-gitlab-sso`

## User's decision (chốt)

1. Truy cập OneMCP qua **public IP `202.92.5.113`** (không private `10.200.0.44` nữa)
2. Bỏ CIDR-based access: `USER_ALLOW_CIDR`, `ADMIN_ALLOW_CIDR`, `TRUSTED_PROXY_CIDR`
3. Bỏ 403 "Privileged role claim from non-admin IP" → không có IP admin/user
4. Phân quyền = username SSO login + env `ADMIN_USERNAMES` bootstrap
5. Admin UI user management: **defer v2** (giữ env bootstrap cho admin đầu tiên)
6. Bridge (OpenWebUI + Alertmanager) → API key (Phase 1B) thay trust-header
7. TLS: **self-signed** (user chấp nhận browser cảnh báo)

## Phát hiện chặn cần fix trước cutover

**TLS cert hiện tại KHÔNG cover public IP.**
```
Subject: CN = onemcp.internal
SANs: DNS:onemcp.internal, DNS:onemcp-vps, IP Address:10.200.0.44, IP Address:127.0.0.1
```
Public IP `202.92.5.113` KHÔNG trong SAN → browser reject "cert name mismatch" (nghiêm trọng hơn self-signed thường).

**Fix:** regenerate cert với SAN:
```
DNS:onemcp.internal
DNS:onemcp-vps
IP:202.92.5.113   ← NEW public
IP:10.200.0.44    ← keep for backward compat
IP:127.0.0.1
```

## Impact 3 plans hiện có

### SSO plan `260727-0843` — **cần UPDATE 8 điểm**

| # | Chỗ đổi | Old | New |
|---|---|---|---|
| 1 | Callback URL | `https://10.200.0.44/api/auth/gitlab/callback` | `https://202.92.5.113/api/auth/gitlab/callback` |
| 2 | iNET GitLab OAuth app Redirect URI | private IP | public IP |
| 3 | Phase 1 §11 "tighten trust-header CIDR-only" | Do | **DELETE** — không CIDR nữa |
| 4 | Env keys | `USER_ALLOW_CIDR`, `ADMIN_ALLOW_CIDR`, `TRUSTED_PROXY_CIDR` | **Remove** hoặc default `0.0.0.0/0` (any) |
| 5 | `ip-cidr.guard.ts` + `admin-cidr.guard.ts` | Enforce | Disable qua env flag `ACCESS_MODE=cidr\|open`, default `open` |
| 6 | `trust-user.middleware.ts` §67-71 | Reject privileged from non-admin IP | Remove CIDR check — trust `ADMIN_USERNAMES` env only |
| 7 | Phase 3 rollout bridge auth | Trust-header từ `TRUSTED_PROXY_CIDR` | Provision bot API key + update OneLog bridge code |
| 8 | Rollback CIDR fallback | `AUTH_MODE=trust-header` accept từ any IP | Cần thêm — hiện không có |

### User management v2 (defer report)
- Giữ nguyên defer
- Note thêm: env `ADMIN_USERNAMES` là bootstrap path (không CIDR check) — admin đầu tiên login SSO với username match env → cấp admin role
- Chicken-and-egg resolved: env bootstrap trước, UI v2 sau

### Portal UI plan `260727-0917`
- Không thay đổi trực tiếp
- Blocked chain: still blocked by SSO plan (đã cover)

## Kiến trúc mới (post-pivot)

```
┌─────────────────┐
│  User anywhere  │  HTTPS public
│  (WFH/mobile)   │─────────────┐
└─────────────────┘             │
                                ▼
                     ┌──────────────────────┐
                     │  onemcp-vps          │
                     │  202.92.5.113        │
                     │  nginx :443          │
                     └──────────┬───────────┘
                                │
                        Session cookie (SSO)
                                │
                                ▼
                     ┌──────────────────────┐
                     │  OneMCP Backend      │
                     │  AuthGuard chain:    │
                     │   → CookieAuth (SSO) │
                     │   → ApiKey (bridge)  │
                     │   → (Bearer webhook) │
                     └──────────────────────┘

Không còn:
  ❌ IP CIDR guard
  ❌ ADMIN_ALLOW_CIDR
  ❌ USER_ALLOW_CIDR
  ❌ TRUSTED_PROXY_CIDR
  ❌ Trust-header (X-Onemcp-User)
```

## Bridge auth migration (Phase 3 SSO rollout)

**Pre-cutover steps (staging):**
1. Login portal với env bootstrap admin (VD `trihd`) → SSO → dashboard
2. Vào `/profile/api-keys` → create bot key label `bridge-openwebui-bot`
3. Copy full key `omk_<prefix8>_<...>` (show once)
4. Update OneLog `infra/openwebui/functions/onemcp-tools.py`:
   - Remove header `X-Onemcp-User`
   - Add header `X-Onemcp-Key: <bot_key>` (Valve)
5. Update `infra/openwebui/actions/onemcp-submit-kb.py`: same
6. Update `/api/users/ensure` endpoint: nhận API key bot auto-provision (đã có logic, chỉ verify chain còn work sau khi bỏ CIDR)
7. Test staging: OpenWebUI submit KB → verify username attribution correct (từ email `__user__` OpenWebUI, không phải bot)

**Alertmanager webhook** — không đổi (Bearer token đã có từ Phase 7 v1).

## Security mitigations (bắt buộc)

Vì public expose → cần layer defense mới:

| Layer | Config |
|---|---|
| Rate limit per IP | nginx `limit_req_zone` — 30 req/min unauth, 120 req/min auth |
| Fail2ban / conn throttle | nginx `limit_conn` — max 20 concurrent per IP |
| Login brute-force | GitLab handle (OAuth flow ở GitLab) — không cần config OneMCP |
| Session hijack | HttpOnly + Secure cookie đã có; consider IP fingerprint check (deferred, YAGNI) |
| Emergency lockdown | Env `EMERGENCY_LOCKDOWN=true` — reject all non-admin (đã có, verify still work) |
| Session TTL | Giữ 24h (recommend); rút 8h nếu risk-averse (env `SESSION_TTL_SECONDS`) |

## Callback URL migration checklist

### Trước cutover
- [ ] Regenerate TLS cert với SAN gồm public IP `202.92.5.113`
- [ ] Deploy cert lên nginx onemcp-vps
- [ ] iNET GitLab admin update Redirect URI OAuth app: `https://10.200.0.44/...` → `https://202.92.5.113/api/auth/gitlab/callback`
- [ ] Backend `.env`: `GITLAB_OAUTH_REDIRECT_URI=https://202.92.5.113/api/auth/gitlab/callback`
- [ ] Verify GitLab có thể reach public IP OneMCP (network probe)

### Cutover
- [ ] Deploy code Phase 1 (SSO backend) + Phase 2 (Portal login)
- [ ] Deploy code với `ACCESS_MODE=open` (bỏ CIDR gate) — canary test
- [ ] Provision bot API key
- [ ] Update OneLog bridge tool/action với API key
- [ ] Test end-to-end: login SSO → dashboard → submit KB via OpenWebUI → verify attribution
- [ ] Flip `AUTH_MODE=gitlab-sso`

### Post-cutover monitor 48h
- Prometheus `auth_login_success/fail`
- Rate limit hits count
- Bridge submit success rate
- Emergency rollback ready

## Rủi ro bổ sung sau pivot

| Risk | Mitigation |
|---|---|
| Browser reject self-signed cert cho public IP → user không login được | Regenerate cert với SAN public IP; docs hướng dẫn user accept cert 1 lần |
| GitLab OAuth callback URL không reachable (network firewall) | Test network probe từ gitlab.inet.vn ra 202.92.5.113 trước cutover |
| DDoS internet-facing | nginx rate limit + emergency lockdown env |
| Attacker brute-force SSO login | GitLab handle, không config OneMCP |
| Bridge API key leak | Store `.env` container, không log; rotation quarterly |
| Admin lock-out sau bỏ CIDR | Env `ADMIN_USERNAMES` bootstrap; emergency: SSH backend + edit env + restart |
| Cert renewal miss → outage | Set calendar reminder; script `gen-tls-san.sh` reuse |

## Non-goals (chốt cứng)

- ❌ Không dùng domain public (`onemcp.inet.vn`) — user chọn IP
- ❌ Không dùng Cloudflare/WAF — user không request
- ❌ Không MFA (GitLab handle)
- ❌ Không Admin UI trong scope này (defer v2)
- ❌ Không migrate DB — bỏ CIDR chỉ là env + code change

## Success metrics

- Portal `https://202.92.5.113/` login flow work end-to-end sau cutover
- Zero 403 "Privileged role claim" trong logs 24h post-cutover
- Bridge OpenWebUI + Alertmanager 0 regression
- Env `ADMIN_USERNAMES` bootstrap: admin login qua SSO → có `roles: ['admin']` (verify `/api/auth/me`)
- Rate limit metrics active — no attack alert first week

## Open questions còn ngỏ

1. **Regenerate cert** — dùng script `plans/reports/gen-tls-san.sh` (đã có từ trước)? Hay Let's Encrypt sau nếu decide dùng domain?
2. **iNET GitLab admin phản hồi** OAuth app chưa? — cần confirm redirect URI mới `https://202.92.5.113/...` (không phải `10.200.0.44` cũ)
3. **Firewall onemcp-vps** — port 443 open outbound tới gitlab.inet.vn? Inbound 443 từ internet open? Cần verify.
4. **DNS `onemcp.inet.vn`** — có cần setup không? Nếu user thật sự chỉ dùng IP thì không. Nhưng cookie Secure trên IP có edge case browser strict — có thể phải fallback domain sau này.
5. **Backup identity path** — nếu SSO down và env `AUTH_MODE=trust-header` fallback — accept từ any IP (không CIDR nữa) → có phải là hole? Recommend: giữ fallback nhưng chỉ accept nếu `EMERGENCY_LOCKDOWN=true` + username in `EMERGENCY_ADMIN_USERNAMES` (mới env).

## Action items

### User (manual)
- [ ] Confirm iNET GitLab admin update Redirect URI OAuth app: `https://202.92.5.113/api/auth/gitlab/callback`
- [ ] Confirm firewall onemcp-vps: outbound 443 → gitlab.inet.vn, inbound 443 từ any (nếu chưa)

### Update SSO plan `260727-0843` files
- [ ] `plan.md` — update callback URL + note bỏ CIDR + link report này
- [ ] `phase-01-oauth-backend.md` — remove trust-header tighten step, update env keys
- [ ] `phase-03-rollout.md` — thêm bridge API key migration step, TLS regeneration step

### Regenerate TLS cert
- [ ] Reuse `plans/reports/gen-tls-san.sh` với SAN mới
- [ ] Deploy lên onemcp-vps `/opt/onemcp/ops/nginx/tls/onemcp.crt`
- [ ] Restart nginx

## Không tạo plan mới

Không invoke `/ck:plan` — thay đổi này **merge vào SSO plan hiện có** (update 8 điểm liệt kê trên). Sau khi update, SSO plan sẽ cover toàn bộ.
