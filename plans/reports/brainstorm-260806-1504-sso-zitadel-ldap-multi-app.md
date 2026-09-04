# Brainstorm — SSO đa app qua Zitadel + Zimbra LDAP + IAP pattern

**Date:** 2026-08-06 15:04
**Status:** Approved, chuyển sang phase plan
**Context:** Session diag Zitadel v4.15.3 LDAP IdP + Zimbra lab (plan `authway/plans/260806-0939-zitadel-ldap-zimbra-lab`)

## Problem

Phòng KT cần SSO cho tất cả app internal (OneLog, OneMCP, các app vibecode tương lai). Login qua Zimbra (single source of truth), Zitadel làm IdP OIDC.

## Constraints (user confirm)

- User scope: KT internal only (Zimbra email accounts)
- Timeline Zimbra prod: < 1 tháng
- Zitadel bug v4.15.3 (SSR fetch Host header) → upgrade v4.16+ để retest
- Auth pattern: **recommend + user chọn**

## Approaches evaluated

| Pattern | Setup per app | Vibecode fit | API/mobile | Verdict |
|---|---|---|---|---|
| OIDC-native mỗi app | 1-2 ngày | ❌ waste | ✅ | Chỉ cho app phức tạp |
| **IAP (oauth2-proxy)** | 5 phút traefik label | ✅ auto | ⚠️ browser-only | **CHỌN** cho 95% use case |
| Hybrid IAP + OIDC opt-in | Mix | ✅ | ✅ | Fallback tương lai |

**Chọn IAP default** vì KT chủ yếu dùng browser + vibecode apps cần onboarding rẻ.

## Kiến trúc chốt

```
KT users (browser)
  │
  ▼
Traefik (edge) ─forwardAuth─► oauth2-proxy ─OIDC─► Zitadel ─LDAP─► Zimbra
  │
  ▼
App backend (đọc X-Forwarded-Email, X-Forwarded-User)
```

## Migration path (Zitadel bug workaround)

**Track 1 (main):** Upgrade Zitadel v4.16+ → retest T1 LDAP → nếu OK close bug.

**Track 2 (parallel fallback):** OneMCP/OneLog ship OIDC direct với Zitadel local user tạm, migrate về LDAP+IAP khi bug fix.

## Phases đề xuất (chi tiết ở plan)

1. **P1 — Zitadel prod deploy** (1-2d): VPS + LE cert + v4.16 (nếu có) + Postgres backup
2. **P2 — Zimbra prod LDAP integration** (0.5d): bind account + LDAPS :636 + firewall + retest T1-T6
3. **P3 — oauth2-proxy IAP baseline** (1d): deploy oauth2-proxy trước Zitadel, verify forwardAuth flow
4. **P4 — Pilot app integrate** (0.5-1d): OneMCP hoặc OneLog first, test E2E
5. **P5 — Onboarding docs + template** (0.5d): 1-page guide cho vibecode dev
6. **P6 — Second/third app rollout** (0.5d each): confirm template repeatable

Tổng: **4-6 ngày** (song song với chờ Zitadel bug fix).

## Risks + mitigation

| Risk | Mitigation |
|---|---|
| Zitadel v4.16 chưa fix bug SSR | Track 2 fallback (OIDC direct) |
| Zimbra prod down → SSO chết toàn bộ | Emergency: Zitadel local admin bypass, disable IdP tạm |
| App leak `X-Forwarded-*` header từ ngoài | Firewall app port, chỉ Traefik set header |
| Vibecode dev không hiểu SSO | 1-page docs + template demo repo |

## Deliverables

1. Zitadel prod running v4.16+ với domain thật (VD `auth.inet.vn`)
2. Zimbra prod bind account (LDAPS)
3. oauth2-proxy IAP deployed + verified
4. `authway/docs/zitadel-ldap-zimbra-integration.md` (kế thừa từ plan hiện tại)
5. `authway/docs/app-onboarding-iap-guide.md` (mới)
6. `authway/templates/app-iap-template/` (verify + refine)
7. 1 pilot app fully SSO-protected (OneMCP hoặc OneLog)
8. Journal bug tracking + resolution

## Success metrics

- ✅ KT user login 1 lần → truy cập tất cả app không re-login
- ✅ Add app mới = 1 file traefik config (< 10 phút)
- ✅ Logout Zitadel = logout mọi app
- ✅ Zimbra password change → next login refresh session
- ✅ Zero secret leak: app không thấy password LDAP thật

## Unresolved / defer

- Domain thật cho Zitadel prod (VD `auth.inet.vn`) — cần user cấp DNS
- MFA policy: bật cho all user hay opt-in? — defer sau T1 pass
- Group sync Zimbra → Zitadel role (Zimbra distribution lists → app roles) — feature request tương lai
- Zitadel HA (multi-node): defer, prod đầu single node đủ
- Vibecode framework recommendation cho dev (Next.js template, etc.) — out of scope brainstorm này

## Next step

Invoke `/ck:plan` với brainstorm context này để tạo detailed implementation plan có 6 phases.
