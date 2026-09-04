# Brainstorm — Authway app-integration-spec (AI-facing template)

**Date:** 2026-09-04 11:34
**Location:** `authway/templates/app-integration-spec/` (via junction, commit trong authway repo)
**Related:** plan `260904-0951-authway-gitlab-sso-prod-hardening` (docs/authway-iap-onboarding.md) — human-facing; spec này AI-facing bổ sung.

## Problem

Member team vibecode dùng AI (Claude/Copilot/Cursor) generate app. Frameworks đa dạng, khó chuẩn hoá runbook cho human. Cần **spec AI đọc** — AI + spec + project code → tự refactor cho Central SSO integration.

Central RBAC portal đã có endpoint tự đăng ký app (`POST /v1/admin/apps` → Zitadel API → return client_id/secret). Còn thiếu: instruction cho AI biết cách refactor app xài client_id/secret đó.

## Non-goals

- Runbook cho human (đã có `authway-iap-onboarding.md` + templates/app-iap-*)
- Central portal generate manifest per-app (defer — YAGNI, spec đủ)
- Backend/frontend framework-specific tuning ngoài 4 reference

## Decision matrix

| Q | Choice | Rationale |
|---|---|---|
| Approach | B — Spec + 4 reference | Cover 90% vibecode, AI có concrete anchor tránh generate lib version sai |
| Default pattern | IAP sidecar (Pattern A) | 90% case refactor delta ~5 dòng — chỉ đọc header |
| Native OIDC (B) | Khi cần token / role JSON claim / SPA thuần | Đúng use case |
| Location | `authway/templates/app-integration-spec/` | Cùng nhóm với template hiện có, member clone authway repo |
| oauth2-proxy pin | `v7.7.1` (đồng bộ app-iap-native) | Repro, tránh AI generate lib mới không tương thích |
| NextAuth version | Auth.js v5 | Vibecode AI hay generate v5 syntax; v4 legacy |
| SPA lib | `oidc-client-ts` | Framework-agnostic (React/Vue/vanilla) |

## Deliverable structure

```
authway/templates/app-integration-spec/
├── README.md                                # (30 dòng) Human landing
├── SPEC.md                                  # (~200 dòng) MAIN — AI contract
├── DECISION-TREE.md                         # (~40 dòng) Pattern A vs B
└── examples/
    ├── nodejs-express-iap.md                # Pattern A
    ├── python-fastapi-iap.md                # Pattern A
    ├── nextjs-app-router-nativeauth.md      # Pattern B — Auth.js v5
    └── spa-react-vue-pkce.md                # Pattern B — oidc-client-ts
```

Total: 7 file, ~700 dòng.

## Usage flow

1. Member request admin đăng ký app trên Central → nhận `{client_id, client_secret, redirect_url}`
2. Member clone `authway/templates/app-integration-spec/` folder
3. Member paste vào AI (Claude/Cursor):
   - SPEC.md (mandatory)
   - DECISION-TREE.md (mandatory)
   - Reference gần nhất framework (VD nodejs-express-iap.md nếu app Node Express)
   - Toàn bộ code project
   - 3 credential từ admin
4. AI refactor project theo spec
5. Member deploy → verify browser flow
6. Nếu fail → gửi log lại AI cùng SPEC.md → AI self-diagnose

## Success criteria

- Spec chỉ định rõ **contract**: Central provides X, app MUST honor Y
- Framework-agnostic **security invariants** (bind 127.0.0.1, cookie_secure, state/nonce)
- **Refactor validation checklist** AI self-check trước khi report done
- 4 reference cover Node/Python/Next.js/SPA (~90% vibecode)
- Nội dung ngắn (spec ≤ 200 dòng) — AI đọc trong 1 lượt context không cần rag

## Risks

| Risk | Mitigation |
|---|---|
| AI generate lib version outdated | Pin version trong reference (oauth2-proxy v7.7.1, Auth.js v5, oidc-client-ts 3.x) |
| Member skip DECISION-TREE → chọn sai Pattern | README nhấn mạnh: "đọc DECISION-TREE trước SPEC" |
| Zitadel URL thay đổi khi HTTPS migration | SPEC dùng var `OIDC_ISSUER` (member fill từ Central) — không hardcode |
| AI over-refactor xoá logic app | SPEC section "AI must NOT touch" liệt kê business logic bảo toàn |

## Follow-up

- Sau khi HTTPS `auth.inet.vn` ready: update SPEC ví dụ scheme `https://` (var-only, low delta)
- Sau khi thêm framework popular (VD Rails / Django): add reference example
- Journal `/ck:journal` sau tạo files

## Unresolved

- Có cần bổ sung example Rails / Django / PHP không? → Defer, add on-demand khi có member request.
- SPEC có nên include example test file (Jest / pytest) verify integration không? → Defer, YAGNI cho v1.
