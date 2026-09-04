# Brainstorm — JWT roles claim size fix (per-app IAP)

**Date:** 2026-09-04 08:20
**Scope:** Preemptive fix cookie oversized khi Central RBAC assign nhiều UserGrant. No infra addition. Per-app targeted (not fleet-wide).

## 1. Problem statement

Zitadel default emit roles claim nested URN structure:

```json
{
  "urn:zitadel:iam:org:project:roles": {
    "role_a": { "orgId-uuid-36chars": "Org Name" },
    "role_b": { "orgId-uuid-36chars": "Org Name" },
    ...
  }
}
```

Mỗi UserGrant ~200-300 bytes (URN key + UUID + orgName). 10 UserGrant → ~2.5-3 KB roles claim. Kết hợp base access token + userinfo → dễ chạm cookie 4KB browser limit khi oauth2-proxy encrypt session vào cookie.

**Incident chưa xảy ra**, nhưng scale Central RBAC (user admin có 15+ roles cross-project) → high risk.

## 2. Constraints (confirmed)

- ❌ NO Redis session store
- ❌ NO fleet-wide apply — chỉ app "role-heavy" (Central RBAC portal, admin dashboards)
- ✅ Preemptive → time để test kỹ
- ✅ Reuse Authway existing IAP pattern (oauth2-proxy sidecar)

## 3. Approaches evaluated

### A. Scope-limited claim (CHỌN) ✅

App request `scope=urn:zitadel:iam:org:project:id:{project_id}:roles` → Zitadel filter claim chỉ cho project cụ thể.

**Pros:** Zero infra, semantic đúng, ~90% size reduction, per-app opt-in.
**Cons:** App onboarding phải config scope đúng (template README update).

### B. Cookie chunking (safety net) ✅

oauth2-proxy native chunk cookie >4KB thành `_0`, `_1`, `_2`.

**Pros:** Zero-config, safety net.
**Cons:** Chỉ delay bottleneck, không fix root.

### C. Zitadel Action compact roles (REJECT)

Custom Action `Post Userinfo` flatten URN → `roles: ["r1", "r2"]`.

**Pros:** Auto reduce mọi user.
**Cons:** Break Zitadel convention, mọi app phải refactor parser, action failure = login fail toàn instance.

### D. Cookie gzip compress (SKIP)

**Cons:** ~30-40% reduce nhưng vẫn không root fix, KISS violation.

## 4. Final recommendation: **A + B combo**

- **A**: Root cause fix, semantic đúng, per-app config
- **B**: Native safety net (no work), cover edge case app quên config scope
- Reject C (over-engineer), D (micro-opt, không đủ)

## 5. Implementation outline

### 5.1 Update template `authway/templates/app-iap-native/README.md`

Add section "Role claim size — scope limiting" cho app dự kiến user >5 UserGrant/project:

```markdown
scope = "openid profile email urn:zitadel:iam:org:project:id:<PROJECT_ID>:roles"
```

### 5.2 Identify apps cần apply

| App | Est. roles/user | Apply scope-limit? |
|---|---|---|
| Grafana OneLog | 1-3 | ❌ Không cần |
| OpenWebUI OneLog | 1-2 | ❌ Không cần |
| Central RBAC portal | 5-20 (admin) | ✅ **CẦN** |
| OneMCP portal | 3-10 | ⚠️ Wait metric, likely CẦN |
| Future admin dashboards | 5+ | ✅ Default apply |

### 5.3 Apply Central RBAC portal (priority 1)

- Scout Central RBAC Zitadel project ID
- Update Central RBAC oauth2-proxy config (or Fastify session middleware nếu native OIDC)
- Verify claim size <2KB post-change

### 5.4 Metric (optional, nếu có bandwidth)

- Prometheus scrape cookie size từ oauth2-proxy metrics endpoint
- Alert if p95 cookie > 3KB (early warning)

## 6. Risks + mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| App parse URN structure (not scope-limit aware) → không thấy roles sau limit | Login OK nhưng authorization broken | Grep codebase tìm `urn:zitadel:iam:org:project:roles` parser → verify khớp scope |
| User admin cross-project login app A chỉ thấy roles A | User confused nếu expect roles xuyên project | Intentional design, document trong app-onboarding guide |
| Existing Zitadel Action `complementRolesClaim` (plan 260819-1628) incompatible scope-limit | Roles claim empty hoặc wrong | Verify action logic — nếu manipulate URN structure, cần adjust |
| Onboarding app mới quên scope config | Cookie oversized bugs return | README template highlight + PR review checklist |

## 7. Success metrics

- ✅ Central RBAC portal: user với 15 UserGrants login OK, cookie <3KB
- ✅ Regression: Grafana OneLog (không scope-limit) vẫn login OK, roles claim đầy đủ nếu có
- ✅ Zitadel Action `complementRolesClaim` still works after scope limit
- ✅ Template README updated + team aware

## 8. Files impacted (est.)

- `authway/templates/app-iap-native/README.md` — add section
- `authway/templates/app-iap-native/oauth2-proxy.cfg.example` — comment scope-limit hint
- `central-rbac/src/config.ts` OR portal oauth2-proxy config — apply scope
- `docs/authway-runbook.md` (optional) — troubleshooting entry

**Không đụng:** Grafana config, OpenWebUI config, LDAP setup.

## 9. Next steps

1. **Phase 1**: Scout existing Zitadel Action `complementRolesClaim` logic (verify scope-limit compat)
2. **Phase 2**: Update template README + config example
3. **Phase 3**: Apply Central RBAC portal (priority 1)
4. **Phase 4**: Verify + document

## 10. Unresolved questions

1. Zitadel Action `complementRolesClaim` (id `386798805829287939` từ plan 260819-1628) hiện handle như thế nào? Có manipulate URN structure không? Cần scout code Action.
2. Central RBAC portal Zitadel project ID = ? Cần scout hoặc query Zitadel API.
3. Có nên add cookie size metric monitoring? YAGNI — defer đến khi có incident thực.
4. Cookie chunking oauth2-proxy version hiện tại (v7.6.0 per authway template) đã support chưa? Verify khi implement.
