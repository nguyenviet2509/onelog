# Brainstorm — Zitadel GitLab Self Hosted IdP + Grafana verify

**Date:** 2026-09-03 13:30
**Scope:** Add GitLab login vào Zitadel v4.16.1 (song song với LDAP Zimbra hiện có), verify qua Grafana `http://10.200.0.30/grafana/dashboards`. Giữ nguyên LDAP.

## 1. Problem statement

- Phòng KT muốn user login OneLog Grafana bằng account GitLab tổ chức (`gitlabs.inet.vn`), bên cạnh LDAP Zimbra Mail đã có.
- Chỉ **refactor thêm** IdP GitLab tại Zitadel — KHÔNG đụng Grafana config, KHÔNG đụng Zimbra LDAP IdP.
- Verify end-to-end qua Grafana login flow.
- Zitadel version: **v4.16.1** (UI screenshot xác nhận).

## 2. Xác định `gitlabs.inet.vn`

**→ GitLab Self Hosted (self-managed Omnibus).**

Bằng chứng (curl headers + `/help` page):
- Domain riêng INET, không phải `gitlab.com`
- Response header `Server: nginx`, `X-Gitlab-Meta`, `X-Gitlab-Correlation-ID`
- `/help` page reference `docs.gitlab.com/ee/` = Enterprise Edition self-hosted
- GitLab.com SaaS chỉ chạy trên `gitlab.com` — không alias

**Kết luận UI action:** trong Zitadel Instance Console → Add provider → chọn tile **"GitLab Self Hosted"** (icon cam, cột 2 hàng 2), KHÔNG chọn tile "GitLab" (preset cứng cho `gitlab.com`).

## 3. Architecture (không đụng Grafana / LDAP)

Grafana đã được wire với Zitadel qua Generic OAuth từ plan `260819-1628` phase 2. Config trong `infra/docker-compose.yml`:

```
GF_AUTH_GENERIC_OAUTH_AUTH_URL:  http://10.200.0.125/oauth/v2/authorize
GF_AUTH_GENERIC_OAUTH_TOKEN_URL: http://10.200.0.125/oauth/v2/token
GF_AUTH_GENERIC_OAUTH_API_URL:   http://10.200.0.125/oidc/v1/userinfo
```

Do đó tất cả app subscribers của Zitadel (bao gồm Grafana) tự động thấy IdP mới ngay khi bật trong Login Policy — không cần deploy lại Grafana.

**Flow:**
```
Grafana /login  →  Zitadel /oauth/v2/authorize
                       ↓
                Zitadel login page:
                  - Password local
                  - Zimbra Mail LDAP (giữ nguyên)
                  - GitLab INET (thêm mới)
                       ↓
                Click GitLab INET → gitlabs.inet.vn/oauth/authorize
                       ↓
                GitLab callback → Zitadel /idps/callback (auto-register/link)
                       ↓
                Zitadel → Grafana /grafana/login/generic_oauth
```

## 4. Approaches evaluated

### Approach A — Add IdP GitLab Self Hosted vào Zitadel (CHỌN)
- **Pros**: Zero config change trên Grafana / LDAP. Reusable cho mọi app sau này (OneMCP, Portal, dashboards khác). Consistent SSO UX. Zitadel handle account linking / auto-register.
- **Cons**: Cần GitLab admin (hoặc user) quyền tạo OAuth Application.

### Approach B — Grafana wire trực tiếp GitLab OAuth (bypass Zitadel)
- **Pros**: Simpler cho 1 app.
- **Cons**: KHÔNG scale (mỗi app đăng ký OAuth riêng). LDAP path phải song song, quản lý 2 identity source ở app-layer. Trái spirit của Authway platform.
- **Verdict**: REJECT — đi ngược architectural direction.

### Approach C — Chờ đến khi Zitadel có federation với GitLab groups
- **Pros**: Cleanest role sync.
- **Cons**: Blocks user goal ngay bây giờ. Overkill nếu chưa cần role mapping.
- **Verdict**: DEFER — làm approach A trước, group mapping sau (không blocking).

## 5. Final solution (Approach A) — Implementation steps

### Step 1 — GitLab: tạo OAuth Application

**URL:** `https://gitlabs.inet.vn/admin/applications` (Instance-level, RECOMMENDED)
Fallback nếu không có admin: `https://gitlabs.inet.vn/-/user_settings/applications`

**Form:**
- Name: `Zitadel INET SSO`
- Redirect URI (mỗi dòng 1 URI):
  - `http://10.200.0.125/idps/callback`
  - (nếu Zitadel có public domain) `https://auth.inet.vn/idps/callback`
- Trusted: ✅
- Confidential: ✅
- Scopes: `openid`, `profile`, `email`, `read_user`

**Output:** copy `Application ID` + `Secret` (secret chỉ hiện 1 lần).

### Step 2 — Zitadel: Add IdP "GitLab Self Hosted"

**URL:** `http://10.200.0.125/ui/console/instance?id=idp`

Click **Add provider** → tile **"GitLab Self Hosted"** (cột 2 hàng 2, icon cam).

**Form:**
| Field | Value |
|---|---|
| Name | `GitLab INET` |
| Client ID | `<Application ID`> |
| Client Secret | `<Secret>` |
| Issuer | `https://gitlabs.inet.vn` |
| Scopes | `openid`, `profile`, `email` (default) |

**Options (checkbox):**
- ✅ Automatic creation
- ✅ Automatic update
- ✅ Account creation allowed
- ✅ Account linking allowed

Click **Create** → detail page → toggle **Available** = ON.

### Step 3 — Zitadel: Attach IdP vào Login Policy

Sidebar → **Login Behavior and Security** → scroll section **Identity Providers** → **Add IdP** → chọn `GitLab INET` → Save.

Verify: `Register allowed` = ON (mặc định).

### Step 4 — Verify qua Grafana

```
1. Incognito → http://10.200.0.30/grafana/dashboards
2. Auto redirect → /grafana/login
3. Click "Sign in with Zitadel"
4. Zitadel login page: verify 3 lựa chọn
   ✓ Password local
   ✓ Zimbra Mail LDAP (còn nguyên — regression check)
   ✓ GitLab INET (mới)
5. Click GitLab INET
6. GitLab login (nếu chưa) → Trusted app skip authorize prompt
7. Callback chain → landing /grafana/dashboards
8. Top-right avatar hiện email GitLab
9. Grafana Server Admin → Users: user auto-created role Viewer
```

## 6. Risks & mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| User email overlap (LDAP + GitLab cùng `x@inet.vn`) | Zitadel prompt link account | Bật "Account linking allowed" (Step 2) — Zitadel handle graceful |
| Zitadel public URL change sau này | Redirect URI mismatch → login fail | Preemptive add cả 2 URI (LAN + public) trong Step 1 |
| Role mapping chưa có | Tất cả user new = Viewer, admin phải manual promote | Out-of-scope brainstorm này. Follow-up plan `role_attribute_path` từ GitLab groups → Grafana role |
| GitLab app không "Trusted" | User bị prompt authorize mỗi lần login | Bật Trusted trong Step 1 |
| Zitadel container không resolve `gitlabs.inet.vn` DNS | IdP discovery fail | Verify `docker exec authway-auth-zitadel-1 nslookup gitlabs.inet.vn` trước Step 2 |

## 7. Success metrics

- ✅ 3 IdP options visible trên Zitadel login page (password + Zimbra + GitLab)
- ✅ LDAP Zimbra login vẫn work (regression test)
- ✅ GitLab user login Grafana successful, auto-created role Viewer
- ✅ Zitadel logs không xuất hiện error `invalid_client` / `redirect_uri_mismatch` / `scope not allowed`

## 8. Debug commands

```bash
# Tail Zitadel logs, filter GitLab IdP events
ssh authway-vps 'docker logs authway-auth-zitadel-1 --since 5m 2>&1 | grep -iE "gitlab|idp|intent|error"'

# Verify DNS resolution từ Zitadel container tới GitLab
ssh authway-vps 'docker exec authway-auth-zitadel-1 nslookup gitlabs.inet.vn'

# Test OIDC discovery endpoint GitLab
curl -s https://gitlabs.inet.vn/.well-known/openid-configuration | jq .
```

## 9. Files impacted

**Không đụng file code nào**. Tất cả thao tác qua UI:
- GitLab admin panel (external)
- Zitadel Instance Console (external, chạy trên authway-vps)

Docs update (nếu tạo plan):
- `authway/docs/app-onboarding-iap-guide.md` — có thể thêm section "Add new IdP" tham chiếu doc này
- Journal entry sau khi ship

## 10. Next steps

1. **Immediate**: chạy 4 bước Step 1→4
2. **Follow-up 1**: nếu cần role mapping (GitLab group → Grafana Editor/Admin), tạo brainstorm mới về `role_attribute_path`
3. **Follow-up 2**: apply same IdP cho các app khác (OneMCP portal, Central RBAC) — không cần thao tác thêm ở Zitadel, chỉ verify per-app

## 11. Unresolved questions

1. GitLab app tạo ở **Instance-level (admin)** hay **user-level** (owner account)? Instance-level chuẩn hơn nhưng cần root GitLab admin — cần confirm ai có quyền.
2. Zitadel truy cập qua public domain `auth.inet.vn` hiện có sẵn chưa? Nếu có, phải preemptive add redirect URI cả LAN + public trong GitLab app.
3. Grafana có team đang login active không? Nếu có → schedule test outside working hour để tránh disrupt.
