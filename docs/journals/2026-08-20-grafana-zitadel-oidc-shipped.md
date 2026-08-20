# 2026-08-20 — Grafana OIDC native (Zitadel) shipped

Phase 2 của plan [260819-1628-zitadel-native-oidc-multi-app-rollout](../../plans/260819-1628-zitadel-native-oidc-multi-app-rollout/plan.md) ship trong ~1h (est 0.5d). Grafana giờ trust Zitadel làm identity + authz source, dual-mode với `auth_proxy` cũ trong lúc soak.

## Kết quả

- User `ldap-test@zimbra8815.inet.name.vn` (role Zitadel = `sale` trên project OneLog) login qua nút **"Sign in with Zitadel"** ở `/grafana/login` → nhận role Grafana **Viewer** (JMESPath fallback do `sale` không map admin/ops).
- Grafana DB verified: 1 user record duy nhất, `user_auth` có 2 row `authproxy` + `oauth_generic_oauth` (auth_id = Zitadel sub `385593087461687299`).
- Zitadel Action `complementRolesClaim` đã có sẵn (trigger Pre Userinfo) → không cần đụng Phase 0. Grafana đọc userinfo endpoint là đủ.

## 3 commit

- `1cffdce` feat(grafana): OIDC native với Zitadel dual-mode auth_proxy
- `e9d27f7` fix(caddy): bypass `/grafana/login` (exact) + `/public/*`
- `d8da865` fix(grafana): `OAUTH_ALLOW_INSECURE_EMAIL_LOOKUP=true`

## Gotchas (learning cho phase sau)

1. **Caddy bind-mount stale sau `git reset`** — `caddy validate` trên host thấy file mới, nhưng container thấy inode cũ. `caddy reload` (SIGHUP) không rescue được vì reload đọc từ container view. **Fix**: `docker compose restart caddy`. Đã note trong memory `bind-mount-stale-after-git-reset.md` từ trước — vẫn suýt trap lại. Cần thói quen: sau `git reset` mà đụng file bind-mount → **luôn restart**, đừng thử reload.

2. **Caddy `handle /path` là exact match** — `handle /grafana/login {}` không match `/grafana/login/` hay `/grafana/login/generic_oauth`. Grafana OAuth flow động path (`/grafana/login` render page, `/grafana/login/generic_oauth` bắt đầu OAuth, `/grafana/login/generic_oauth?code=...` callback). Phải khai 3 handle: exact + `/*` + `/public/*` (assets).

3. **"User sync failed — user already exists"** khi bật OAuth song song auth_proxy — user cũ đã có `user_auth` row `authproxy`. OAuth cố tạo user mới cùng email → conflict. Fix bằng `GF_AUTH_OAUTH_ALLOW_INSECURE_EMAIL_LOOKUP=true` — Grafana link OAuth vào record hiện có (2 auth modules cùng 1 user record). Setting này chỉ "insecure" khi Grafana không control email verification, ở đây Zitadel verified email nên OK.

## Điểm hay của pattern (validated)

- Zitadel làm central authz — chỉ setup 1 Action + assert_roles 1 lần, app đọc qua userinfo tự flatten.
- Dual-mode giữ IAP an toàn — nếu OIDC fail user vẫn login được qua auth_proxy. Retire IAP ở Phase 4 sau khi soak.
- `role_attribute_path` JMESPath fallback = Viewer → không lock-out user chưa được gán role đúng.

## Update 2026-08-20 (sau journal ban đầu 30 phút) — role change verified + gotcha #4

Test đổi role Zitadel `sale`→`admin`, re-login: role Grafana KHÔNG đổi. Debug log level cho thấy userinfo response chỉ chứa **raw claim** `urn:zitadel:iam:org:project:roles` (object verbose), KHÔNG có claim `roles` flat array — Action `complementRolesClaim` (Actions v1) KHÔNG chạy dù state=active + attach flow đúng.

**Root cause nghi ngờ**: instance feature `login_v2=true` (Zitadel v4.16.1 default) bypass Actions v1 execution. Chưa verify chính thức. Xem plan Unresolved.

**Fix workaround** (đã ship commit `651bde6`): JMESPath dùng `keys()` đọc trực tiếp raw claim:
```
contains(keys("urn:zitadel:iam:org:project:roles"), 'admin') && 'GrafanaAdmin' || ...
```

Verified end-to-end: Zitadel role `admin` → Grafana `is_admin=1, role=Admin` (GrafanaAdmin server-level).

**Impact toàn plan**: mọi phase sau đọc claim `roles` (Phase 1 OpenWebUI, Phase 3 OneMCP backend JWT verify) đều phải theo pattern raw claim. Phase 0 revisit: cần điều tra Actions v2 migrate hoặc chấp nhận pattern workaround làm chuẩn.

## Còn nợ

- ~~Test đổi role Zitadel~~ ✅ done (nhưng hit Actions v1 bypass — xem update trên).
- Test SSO cross-app khi Phase 1 (OpenWebUI) xong: login OpenWebUI → mở Grafana → silent auth.
- Central logout chain khi cả 2 app OIDC.
- 48h soak để confirm không có regression IAP path.

## Next

- Phase 1 — Open WebUI OIDC (shared-admin identity break-change, cần broadcast trước).
- Phase 3 — OneMCP portal + backend OIDC.
- Sau Phase 4 → review plan 260812-1150 (Central RBAC service): nhiều khả năng defer/downgrade vì Zitadel đủ cho use case hiện tại.
