# Brainstorm: Central RBAC — Admin UX, mTLS, App Self-Registration

**Date:** 2026-08-26 16:44 | **Author:** brainstorm session | **Trigger:** post plan 260821-1644-central-rbac-single-pane MVP done

## 1. Vấn đề (Problem statement)

Sau khi MVP central-rbac chạy được ở review mode, còn 4 lỗ hổng UX + security cần giải quyết trước khi mở rộng đón adopter thứ 2:

1. **Admin UX split** — admin non-tech phải vào Zitadel console tạo project + client, rồi qua central-rbac UI phân quyền, rồi (tệ hơn) sửa YAML seed + redeploy để thêm permission mới. 3 nơi, 2 tool khác nhau, cần dev support.
2. **Service-to-service auth** — hiện tại downstream service gọi central-rbac `/v1/resolve` bằng `X-Rbac-Token` (shared secret) qua HTTP plaintext trong docker network. Cross-VPS chưa có adopter, nhưng khi indexer/OneMCP backend gọi từ VPS khác lên rbac VPS → shared secret + TLS thường bị đánh giá không đủ.
3. **TLS thường (server-cert only) chưa đủ** — chỉ chứng thực server, không chứng thực caller. Kẻ tấn công đã có access LAN → có thể replay/relay request nếu leak secret.
4. **Permission registration friction** — mỗi lần app mới muốn khai báo permission (`myapp.foo.read`), phải PR vào `config/seed/permissions.yaml` + rebuild + deploy central-rbac. App team không tự làm được.

## 2. Trạng thái hiện tại (Baseline — scout kết quả)

| Chiều | Hiện trạng | File / evidence |
|---|---|---|
| Tạo app project | Manual ở Zitadel console; role/permission qua YAML seed + `bootstrap-dev.ts` | `config/seed/{permissions,roles}.yaml`, plan line 20 |
| Assign user → role | UI central-rbac Phase 4 (grant/revoke dialog) | `central-rbac/src/routes/users.ts` |
| Downstream check permission | JWT claim `permissions[]` (issued by Zitadel post-token via central-rbac webhook), verify JWKS | `routes/webhook-pre-token.ts` |
| Admin call `/v1/resolve` | Shared secret `X-Rbac-Token` HTTP (plaintext trong docker network) | F4 fix, `middleware/auth-*.ts` |
| Cross-VPS call | Chưa có adopter thực → chưa expose ra ngoài `authway-prod_internal` | plan line 37 |
| TLS termination | Traefik v3.7 (đang HTTP-only pilot; Sectigo cert chờ user cấp) | plan line 49 |
| Permission update flow | YAML edit → git push → CI build → `docker compose up -d rbac-api` → bootstrap idempotent replay | `scripts/bootstrap-dev.ts` |

## 3. Design options (per concern)

### 3.1. Concern #1 — Admin UX: gộp Zitadel project setup vào Central RBAC UI

**Options:**

| # | Approach | Pros | Cons | Verdict |
|---|---|---|---|---|
| A | **Full proxy wizard**: Central RBAC UI có wizard "New App Project" gọi Zitadel Mgmt API server-side → tạo project + OIDC client + default roles trong 1 form | Non-tech admin chỉ dùng 1 UI; đúng "single pane" spirit của plan | Cần cấp thêm scope `AddProject`, `AddOIDCApp` cho SA (đang tránh IAM_OWNER); wizard form dài (redirect URIs, grant types, PKCE, token lifetime — non-tech dễ sai) | ✅ Recommended cho common case |
| B | **Zitadel-first + auto-detect**: Admin vẫn tạo project ở Zitadel; central-rbac worker poll `SearchProjects` mỗi 60s, phát hiện project mới → gợi ý admin vào UI define role/permission | Không cần scope Zitadel-write, giữ SA scope hẹp | Vẫn 2 nơi; auto-detect chậm; không giải quyết pain non-tech admin | ❌ Skip |
| C | **Hybrid wizard "simplified"**: UI chỉ hỏi 3 field (app name, callback URL, permission manifest URL) → server gọi Zitadel `AddProject` + `AddOIDCApp` với default sane (Auth Code + PKCE, refresh token 30d), refuse edge cases | Hide phức tạp Zitadel; 90% common case tự động; edge case (SPA-only, service account, machine-to-machine) fallback về Zitadel console + banner "advanced" | Cần document rõ default; wizard có thể sai khi Zitadel v5 đổi API | ✅ Recommended |

**Recommendation:** **C (Hybrid wizard)** — best UX/complexity ratio. YAGNI cho edge case: 90% adopter là web app OIDC standard, wizard cover đủ. Edge case (machine account, SPA-only) hiếm và dev-heavy → OK để dev-support.

**Implementation sketch:**
- New route `POST /v1/admin/apps` — body: `{name, callback_urls[], permission_manifest_url?}`
- Server: (1) call Zitadel `AddProject` + `AddOIDCApp` với defaults, (2) create role skeleton `{app}.viewer`, `{app}.editor`, `{app}.admin`, (3) return `{project_id, client_id, client_secret}`
- Scope Zitadel SA: thêm `PROJECT_CREATOR` custom role (Zitadel v4 hỗ trợ per-role granularity — kiểm tra lại)
- UI: wizard 2-step: (step 1) app info, (step 2) preview + confirm

**Trade-off cost:** +2 tuần dev, +1 tuần security review Zitadel SA scope escalation.

---

### 3.2. Concern #2 + #3 — Service auth + TLS: bảo mật cross-VPS call

**Threat model cần chốt:** hiện tại VPS trust boundary là `10.200.0.0/24` private network. Ai đã ở trong LAN đó được coi là trusted? Nếu có, JWT + TLS thường đủ. Nếu không (VPS compromise → lateral movement threat), cần defense in depth.

**Options:**

| # | Approach | Auth strength | Ops burden | Verdict |
|---|---|---|---|---|
| A | **JWT-only** (Zitadel service account token, JWKS verify, TLS thường) | Strong crypto (RS256/ES256), short-lived (1h), auto-rotate | Zero infra thêm; Zitadel đã có SA feature | ✅ Baseline cho common case |
| B | **JWT + mTLS ở Traefik entrypoint** (client cert issued by internal CA, Traefik verify + pass identity qua header) | Rất mạnh: 2-factor (token + cert). Cert = pin thiết bị, không stealable qua log/env dump | Cần CA + issue + rotate cert. Manual OK 3-4 services; tương lai dùng Step-CA hoặc HashiCorp Vault PKI | ✅ Recommended cho `/v1/resolve` + admin APIs |
| C | **Service mesh (Istio/Linkerd sidecar)** | Auto mTLS + workload identity SPIFFE | Overkill; +1 sidecar/container; nutrition mesh CP; steep learning | ❌ Skip (YAGNI) |
| D | **Wireguard mesh giữa VPS** | Encrypt + auth ở L3, transparent cho app | Không chứng thực app-level identity; VPS compromise → wg key compromise; không thay thế được app auth | ⚠️ Bổ sung, không thay thế |

**Recommendation:** **A cho baseline + B cho sensitive endpoints**

- **Baseline (mọi service):** Zitadel-issued SA JWT, JWKS verify, TLS terminate ở Traefik với Sectigo cert. Bỏ shared secret `X-Rbac-Token`.
- **Sensitive endpoints** (`/v1/resolve`, `/v1/admin/*`, webhook pre-token từ Zitadel): thêm mTLS ở Traefik entrypoint. Client cert = manual issue từ internal CA (Step-CA container, chạy sidecar central-rbac stack).

**Rationale:**
- Threat model onelog thực tế: LAN 10.200 = semi-trusted (multiple VPS admin, tối đa 3 person), nhưng compromise 1 VPS → lateral thấy hết. → mTLS đáng đầu tư cho endpoints trực tiếp cấp quyền/token.
- JWT alone = chứng thực caller identity nhưng token có thể bị leak qua log, env dump, memory scrape. mTLS cert = bind identity vào file trên disk → phải compromise disk mới lấy được.
- Wireguard riêng biệt: gợi ý nếu cross-DC (VPS ở 2 datacenter khác nhau). Trong 1 DC thì Traefik + mTLS đủ.

**Implementation sketch:**
- Step 1 (baseline): Zitadel tạo SA cho mỗi service consumer (`indexer-sa`, `onemcp-backend-sa`, `portal-sa`). Central-rbac verify SA JWT bằng existing JWKS logic (đã có). Loại bỏ `X-Rbac-Token` middleware.
- Step 2 (mTLS): deploy `smallstep/step-ca` container trong stack authway-vps. Bootstrap: 1 root CA + 1 intermediate cho service auth. Central-rbac Traefik router `/v1/resolve` thêm middleware `ClientCA` (Traefik v3 hỗ trợ `mTLS`).
- Cert rotation: 90-day cert, script `step ca certificate` gen mới → rsync lên VPS consumer → docker restart. Ban đầu manual, sau này script hóa.

**Trade-off cost:** +1 tuần Zitadel SA setup + JWT verify hardening; +2 tuần mTLS PoC + rotation runbook.

**Anti-pattern cần tránh:** **KHÔNG** dùng self-signed cert per service, không có CA. Sau 6 tháng cert soup, không ai biết cert nào của ai.

---

### 3.3. Concern #4 — App self-registration of permissions

**Options:**

| # | Approach | DX | Security | Verdict |
|---|---|---|---|---|
| A | **Manifest endpoint tại app + admin gate**: app expose `/.well-known/rbac-permissions.json`. Central-rbac fetch on-demand khi admin trigger "Import permissions from app". Diff hiển thị (add/remove/rename). Admin approve → merge vào DB | Best DX cho dev; admin control | Admin cần review kỹ; diff UI cần tốt để tránh sai | ✅ Recommended |
| B | **Boot-time registration API**: app POST `/v1/apps/{id}/permissions` khi start với SA token. Central-rbac merge auto (chỉ cho phép add, không delete/rename). Delete/rename qua admin UI | Fully automated | Rủi ro app team ship permission bug → auto-apply → hard to revert | ⚠️ Rủi ro cao |
| C | **Git-ops via app repo**: mỗi app commit `permissions.yaml` vào chính repo của mình + tag. Central-rbac có bot poll GitHub API, fetch tag mới, PR vào central-rbac config repo. Admin merge PR → CI redeploy | Có audit trail git-native | Cross-repo git-ops phức tạp; central-rbac phải có GitHub token; PR flow chậm | ❌ Overkill |
| D | **CLI tool `rbac-cli register`**: dev chạy local, tool gọi central-rbac API (SA auth) → tạo pending change → admin approve trong UI | Middle ground | Cần build + maintain CLI | ⚠️ Consider cho phase 2 |

**Recommendation:** **A (Manifest fetch + admin gate)** — kết hợp DX tốt (app team chỉ cần expose 1 endpoint) + control (admin review trước khi apply).

**Manifest schema (proposal):**
```json
{
  "app_id": "onemcp",
  "version": "2026.08.26",
  "permissions": [
    {
      "key": "onemcp.kb.read",
      "description": "Đọc knowledge base",
      "since_version": "2026.01.01",
      "deprecated_by": null
    },
    {
      "key": "onemcp.kb.write",
      "description": "Ghi knowledge base",
      "since_version": "2026.01.01"
    }
  ],
  "default_roles": [
    { "key": "onemcp.viewer", "permissions": ["onemcp.kb.read"] },
    { "key": "onemcp.editor", "permissions": ["onemcp.kb.read", "onemcp.kb.write"] }
  ]
}
```

**Flow:**
1. App team commit `permissions.json` vào repo + expose qua static file server `/.well-known/rbac-permissions.json`
2. Admin vào Central RBAC UI → "Apps" tab → click "Sync from manifest"
3. Central-rbac fetch manifest, compute diff vs DB current state
4. Diff UI: green (add), yellow (update description), red (deprecate) — không cho phép delete (immutable key policy)
5. Admin review + click "Apply" → write vào DB, emit audit log

**Immutability rule (giữ nguyên MVP):** một khi permission key đã tồn tại → không thay đổi ngữ nghĩa, chỉ được deprecate (soft-delete) + alias sang key mới.

**Namespace ownership:** app `onemcp` chỉ được declare permissions `onemcp.*`. Middleware reject cross-namespace.

**Trade-off cost:** +2 tuần (endpoint fetch + diff UI + audit log + namespace validator).

---

## 4. Recommendation tổng hợp (final proposal)

Roadmap 3-phase, YAGNI ordering:

### Phase 6 (2 tuần) — Security foundation
Prerequisite cho các phase sau. Không có UI change lớn.
- Bỏ `X-Rbac-Token` shared secret
- Thay bằng Zitadel SA JWT verify (JWKS-based, tận dụng code có sẵn)
- Traefik terminate HTTPS với Sectigo cert (đợi user cấp domain + cert)
- Deploy `step-ca` intermediate, issue client cert cho 3 SA đầu tiên
- Traefik router `/v1/resolve` + `/v1/admin/*` bật mTLS
- Runbook rotate cert 90-day

### Phase 7 (2 tuần) — Admin single-pane wizard
- `POST /v1/admin/apps` — proxy Zitadel `AddProject` + `AddOIDCApp` với defaults
- Escalate Zitadel SA scope (add `PROJECT_CREATOR`)
- UI wizard "New App Project" 2 steps
- Đóng gap non-tech admin

### Phase 8 (2 tuần) — App self-registration
- Manifest schema + validator
- Endpoint `POST /v1/admin/apps/{id}/sync-manifest` fetch + diff
- UI diff review + apply
- Namespace ownership enforcement
- Deprecation flow (không hard delete)

**Total:** ~6 tuần dev + ~2 tuần security review.

## 5. Rủi ro & mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Zitadel SA escalate scope (add `PROJECT_CREATOR`) → nếu SA compromise, kẻ tấn công tạo project rác | Medium | Rate limit `POST /v1/admin/apps` = 5/day; audit log every create; alert nếu >3/day |
| mTLS cert leak → attacker mạo danh service | High | 90-day rotation; revoke via CRL/OCSP; log per-cert access; principle of least privilege (mỗi SA cert scope 1 endpoint) |
| Manifest sync auto-apply bug → wipe permission → mất phân quyền | Critical | Admin gate (approve-per-diff); soft-delete only; DB backup pre-apply; rollback endpoint |
| Zitadel v4→v5 API break | Medium | Wizard code isolate qua adapter interface; smoke test CI mỗi Zitadel upgrade |
| Cert manual rotate quên → outage | Medium | Cron alert 30-day trước expire; script `check-cert-expiry.sh` chạy daily |

## 6. Alternatives explicitly rejected

- **Full service mesh (Istio)**: over-engineering, 4 services không cần CP mesh
- **Delete Zitadel, all-in-one central-rbac**: mất OIDC standard compliance; app đã tích hợp qua Zitadel
- **Convert to Keycloak**: migration cost > benefit
- **Wireguard mesh**: cân nhắc riêng nếu cross-DC; không thay mTLS

## 7. Success criteria

- [ ] Admin non-tech tạo app mới trong <5 phút, chỉ dùng central-rbac UI
- [ ] Zero shared secret trong service-to-service auth
- [ ] `/v1/resolve` yêu cầu mTLS + JWT double check
- [ ] Cert rotation runbook tested end-to-end
- [ ] App team ship permission mới không cần touch central-rbac repo
- [ ] Audit log cover: app create, permission sync, cert issue

## 8. Câu hỏi mở (unresolved)

1. **Zitadel `PROJECT_CREATOR` scope**: v4.16.1 có expose granular scope này không? Cần verify qua Zitadel Mgmt API doc trước khi commit approach C cho concern #1.
2. **step-ca vs Vault PKI**: step-ca đơn giản hơn nhưng Vault đã dùng ở đâu chưa trong onelog stack? Nếu chưa, chọn step-ca. Nếu có Vault, tận dụng.
3. **Cross-DC threat model**: OneMCP-vps, onelog-vps, authway-vps có cùng DC không? Nếu khác DC → cần Wireguard bổ sung trước mTLS.
4. **Adopter thứ 2 là app nào**: cần chốt để design wizard defaults (web OIDC vs SPA vs machine account).
5. **Manifest fetch: pull vs push**: pull (admin trigger) an toàn hơn nhưng cần fetch endpoint; push (app POST khi start) thuận DX hơn nhưng cần auth strong. Đề xuất pull, cần user confirm.
