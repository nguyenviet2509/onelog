---
type: brainstorm
date: 2026-08-25 09:57 +0700
plan: 260821-1644-central-rbac-single-pane
decision_reverses: plan.md V4 (2026-08-22)
status: approved
---

# Brainstorm — Central RBAC Phase 4-5 IP-first review mode

## Problem

User request: cook Phase 4-5 với URL public VPS IP (HTTP) để review UI + chức năng trước. Sau khi OK sẽ cấp `<RBAC_DOMAIN>` + Sectigo cert → swap sang domain.

Reverses V4 decision từ 2026-08-22 ("Setup subdomain + HTTPS TRƯỚC Phase 4 để OIDC redirect_uri không đổi 2 lần").

## Feasibility — Yes, low risk

Zitadel v4 hỗ trợ dev-mode redirect URI HTTP trên non-localhost IP. Central RBAC + Zitadel co-locate authway-vps, Traefik 3.7 route được cả 2 mode qua env vars + router labels. Swap cost ~15-20 phút config, không sửa code.

## Approaches evaluated

### Option A — HTTP + public VPS IP (CHOSEN)
- Traefik entrypoint `web:80` on public VPS IP
- Cookie `Secure=false`, `SameSite=Lax`
- Zitadel client redirect URI: `http://<VPS_PUBLIC_IP>/callback`
- Pros: simplest, matches current Zitadel HTTP-only pattern, no browser warning
- Cons: cookie ko `Secure` (dev-only trade-off), traffic plain HTTP

### Option B — HTTPS + self-signed cert on IP (rejected)
- Traefik generates self-signed cert cho VPS IP SAN
- Cookie `Secure=true` từ đầu → gần prod behavior
- Pros: closer to prod, force `Secure` cookie testing sớm
- Cons: browser warning mỗi review session, complexity Traefik cert config, minimal marginal safety

### Option C — Ngrok/CF tunnel (rejected)
- Public HTTPS URL tạm
- Cons: URL đổi khi restart, ko phù hợp review period dài, external dependency

## Chosen design

### Deployment layout (review period)

```
Internet
  → <VPS_PUBLIC_IP>:80 (Traefik entrypoint web)
    → Host(<VPS_PUBLIC_IP>) + PathPrefix(/v1) → central-rbac API :8083
    → Host(<VPS_PUBLIC_IP>) default → central-rbac-ui :80

  → 10.200.0.125:8080 (Zitadel, unchanged HTTP-only)
```

- Same-origin UI + API qua chung Traefik host
- Zitadel giữ HTTP-IP suốt review — `ZITADEL_ISSUER` ko đổi
- Zitadel OIDC client added redirect URI `http://<VPS_PUBLIC_IP>/callback`

### Env vars phân biệt IP mode / domain mode

| Var | IP mode (review) | Domain mode (final) | Notes |
|---|---|---|---|
| `CENTRAL_RBAC_PUBLIC_URL` | `http://<VPS_PUBLIC_IP>` | `https://rbac.<domain>` | Self-URL + OIDC callback host |
| `CENTRAL_RBAC_CORS_ORIGIN` | `http://<VPS_PUBLIC_IP>` | `https://rbac.<domain>` | Backend CORS allow-list |
| `SESSION_COOKIE_SECURE` | `false` | `true` | Cookie `Secure` flag |
| `SESSION_COOKIE_SAMESITE` | `lax` | `lax` | Same in both modes |
| `ZITADEL_ISSUER` | `http://10.200.0.125:8080` | `https://zitadel.<domain>` (khi swap Zitadel) | Ko đổi trong review nếu Zitadel giữ IP |
| `VITE_API_BASE_URL` | `/v1` | `/v1` | Same-origin relative |

### Zitadel OIDC client redirect URI strategy

Phase 4 setup: **add `http://<VPS_PUBLIC_IP>/callback`** ngay. Khi cấp domain: **add `https://rbac.<domain>/callback` song song** (ko remove IP URI ngay). Chỉ remove IP URI sau khi domain stable production ≥ 1 tuần.

### Traefik router labels (compose)

```yaml
central-rbac:
  labels:
    - traefik.enable=true
    - traefik.docker.network=authway-prod_edge
    - "traefik.http.routers.central-rbac-api.rule=Host(`${RBAC_HOST}`) && PathPrefix(`/v1`)"
    - traefik.http.routers.central-rbac-api.entrypoints=${RBAC_ENTRYPOINT}
    - traefik.http.routers.central-rbac-api.tls=${RBAC_TLS_ENABLED}
    - traefik.http.services.central-rbac-api.loadbalancer.server.port=8083

central-rbac-ui:
  labels:
    - traefik.enable=true
    - traefik.docker.network=authway-prod_edge
    - "traefik.http.routers.central-rbac-ui.rule=Host(`${RBAC_HOST}`)"
    - traefik.http.routers.central-rbac-ui.entrypoints=${RBAC_ENTRYPOINT}
    - traefik.http.routers.central-rbac-ui.tls=${RBAC_TLS_ENABLED}
    - traefik.http.services.central-rbac-ui.loadbalancer.server.port=80
```

**Env-driven** — `RBAC_HOST=<VPS_PUBLIC_IP>` + `RBAC_ENTRYPOINT=web` + `RBAC_TLS_ENABLED=false` cho review; swap cả 3 khi có domain.

## Swap-later procedure (khi anh cấp domain + cert)

1. Copy Sectigo cert → `/opt/authway/infra/authway-vps/certs/`
2. Verify SAN cover `rbac.<domain>` + `zitadel.<domain>`
3. Add `websecure:443` entrypoint vào `traefik.yml` + HTTP→HTTPS redirect
4. Add `dynamic/tls.yml` cert declaration
5. Edit `.env`: `RBAC_HOST=rbac.<domain>` + `RBAC_ENTRYPOINT=websecure` + `RBAC_TLS_ENABLED=true` + `CENTRAL_RBAC_PUBLIC_URL=https://rbac.<domain>` + `CENTRAL_RBAC_CORS_ORIGIN=https://rbac.<domain>` + `SESSION_COOKIE_SECURE=true`
6. Add DNS A record `rbac.<domain>` → VPS public IP
7. Zitadel Console → central-rbac-ui OIDC app → add `https://rbac.<domain>/callback` (giữ IP URI song song)
8. `docker compose up -d --force-recreate central-rbac central-rbac-ui`
9. Verify HTTPS load + OIDC login end-to-end via domain
10. (Later, ≥ 1 tuần stable) remove IP redirect URI khỏi Zitadel client + revert `RBAC_HOST` IP config

Est. 15-25 phút. Zero code change.

## Zitadel domain swap (separate, later)

User chọn giữ Zitadel HTTP-IP suốt review. Khi Zitadel domain swap:
- `ZITADEL_EXTERNAL_DOMAIN`, `ZITADEL_EXTERNALSECURE=true`, `ZITADEL_EXTERNALPORT=443`
- Traefik router `zitadel` swap `entrypoints=websecure` + `tls=true`
- Central RBAC env `ZITADEL_ISSUER` update
- Zitadel restart (~30s downtime)

Có thể defer sau khi Central RBAC swap OK, tách 2 event.

## Risks + mitigation

| Risk | Mitigation |
|---|---|
| Quên đảo `SESSION_COOKIE_SECURE=true` khi swap → cookie ko `Secure` prod | Documented in swap runbook + smoke test HTTPS cookie flag |
| Zitadel client redirect URI missing IP mode → OIDC callback fail | Phase 4 checklist: add IP URI trước dev start |
| Traefik router precedence khi có 2 host rule | Test router.priority = 200 (API) > 100 (UI) same as domain plan |
| User confuse IP mode = production | Add banner UI "REVIEW MODE — không dùng cho production" |
| Public IP HTTP exposes admin surface plain-text | Trong review period, limit source IP qua VPS firewall (allow only anh + team dev) |

## Plan file updates required

- `phase-04-ui-users-assignments.md`: Step 2 OIDC redirect URI — allow IP fallback as PRIMARY for review mode. Add env vars section. Update prereq (remove domain hard-block).
- `phase-05-seed-deploy.md`: Step 6 Traefik labels — parameterize via env vars. Step 7 `.env.example` — split IP/domain sections. Add Step 17.5 "Swap IP→domain procedure". Move step 17 "DNS+TLS" từ blocking Phase 4 → optional post-review.
- `plan.md`: mark V4 decision reversed 2026-08-25 với rationale (review UI first) + link brainstorm report.

## Success criteria (review mode)

- Login qua `http://<VPS_PUBLIC_IP>` → users list < 3s
- OIDC callback complete via IP redirect URI
- All Phase 4 UI flows functional (grant, revoke, bulk assign, degraded banner)
- Zero code change required to swap IP→domain sau đó
- Banner "REVIEW MODE" visible on UI

## Unresolved

1. VPS public IP dùng cho review — anh confirm IP cụ thể (202.92.5.x?) hay dùng private IP + SSH tunnel?
2. Firewall policy IP allow-list source trong review period — cần config ở đâu (Traefik middleware, iptables, VPS provider firewall)?
3. Zitadel org `spike-test` giữ dùng cho review, hay tạo Org mới `central-rbac-review`?
