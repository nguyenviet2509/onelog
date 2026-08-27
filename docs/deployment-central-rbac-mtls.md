# Central RBAC mTLS Deployment Runbook

**Plan:** [260826-1644-central-rbac-hardening-and-self-service](../plans/260826-1644-central-rbac-hardening-and-self-service/plan.md) — Phase 06

Golden rules:

- **KHÔNG** deploy step-ca vào prod trước khi PoC pass trên `onelog-source` lab
- **KHÔNG** xoá `X-Rbac-Token` cho đến khi mọi consumer đã migrated sang mTLS + verified 48h
- **KHÔNG** để root_ca.key trên VPS sau khi intermediate signed — Age-encrypt + offline ngay
- **LUÔN** verify Traefik 2-TLS-options pattern qua Step 6a spike matrix trước khi push prod

## Phase 06 Step 0 — step-ca PoC gate (1-day timeboxed on lab)

Deploy `onelog-source` VPS. Verify 3 deliverables:

```bash
# 1. Pull pinned digest (record actual digest)
docker pull smallstep/step-ca@sha256:<PLACEHOLDER-PIN-AFTER-FIRST-PULL>
docker inspect --format='{{.RepoDigests}}' smallstep/step-ca:latest

# 2. Non-interactive init (should print "step-ca initialized" without TTY prompts)
STEPPATH=/opt/step-ca \
DNS_NAMES=step-ca,rbac.internal.local,10.200.0.53 \
PROVISIONER_PASSWORD_FILE=/root/.secrets/step-ca-provisioner.pwd \
ROOT_PASSWORD_FILE=/root/.secrets/step-ca-root.pwd \
/opt/authway/step-ca/init.sh

# 3. Client-cert handshake works
/opt/authway/scripts/issue-client-cert.sh onemcp-backend 24h
openssl s_client -connect step-ca:9000 \
  -cert /root/.certs/clients/onemcp-backend-cert.pem \
  -key /root/.certs/clients/onemcp-backend-key.pem \
  -CAfile /opt/step-ca/certs/root_ca.crt </dev/null 2>&1 | grep "Verify return code"
# Expect: "Verify return code: 0 (ok)"
```

**Gate:** all 3 pass → proceed. Any fails → escalate for Vault fallback decision (do NOT proceed).

## Phase 06 Step 4 — Deploy step-ca sidecar (docker-compose patch)

Add to `authway/infra/authway-vps/docker-compose.yml`:

```yaml
services:
  step-ca:
    image: smallstep/step-ca@sha256:<PIN-FROM-STEP-0>
    restart: unless-stopped
    volumes:
      - step-ca-data:/home/step
      - ./step-ca:/init:ro
    environment:
      DOCKER_STEPCA_INIT_NAME: "OneLog Central RBAC CA"
      DOCKER_STEPCA_INIT_DNS_NAMES: "step-ca,rbac.internal.local,10.200.0.125"
    networks:
      - authway-prod_internal
    ports:
      - "10.200.0.125:9000:9000"
    healthcheck:
      test: ["CMD", "step", "ca", "health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
    logging:
      driver: journald

  traefik:
    depends_on:
      step-ca:
        condition: service_healthy   # Fix #10
    volumes:
      - step-ca-data:/run/step-ca:ro  # mount intermediate CA for tls-options.yml

  central-rbac:
    depends_on:
      step-ca:
        condition: service_healthy   # Fix #10
    secrets:
      - cert_hmac_current            # Validation Session 1 Decision

secrets:
  cert_hmac_current:
    external: true
    name: cert_hmac_v1               # bumped by rotate-cert-hmac.sh weekly

volumes:
  step-ca-data:
```

**Root key backup step (Validation Session 1 Decision — MANDATORY):**

```bash
# After init succeeds
scp authway-vps:/var/lib/docker/volumes/authway-vps_step-ca-data/_data/secrets/root_ca_key /tmp/
age -R /path/to/backup-age.pub -o /secure/backup/root_ca_key.age /tmp/root_ca_key
# Store root_ca_key.age in Bitwarden (attachment) + print QR paper backup
shred -u /tmp/root_ca_key
docker exec step-ca shred -u /home/step/secrets/root_ca_key
# Intermediate key STAYS on VPS (needed for signing)
```

## Phase 06 Step 6 + 6a — Traefik TLS options + verification spike

**Config:** already written at [`authway/infra/authway-vps/dynamic/tls-options.yml`](../authway/infra/authway-vps/dynamic/tls-options.yml).

**Spike matrix (MUST pass before Step 7):**

```bash
# On lab, after Traefik reload:
# webhook path (mtls-optional), no cert — expect 200 (or 401 from HMAC middleware, not TLS fail)
curl -k https://rbac.lab.local/webhooks/pre-token -d '{}' -w '%{http_code}\n'

# webhook path, with cert — expect 200
curl -k --cert client.pem --key client.key https://rbac.lab.local/webhooks/pre-token -d '{}' -w '%{http_code}\n'

# resolve path (strict-mtls), no cert — expect TLS handshake fail
curl -k https://rbac.lab.local/v1/resolve -w '%{http_code}\n' 2>&1 | grep -i "handshake"

# resolve path, with cert — expect 200
curl -k --cert client.pem --key client.key https://rbac.lab.local/v1/resolve -w '%{http_code}\n'
```

**If spike fails** (both paths reject cert OR both allow no-cert): pattern broken in Traefik v3.7 → fallback to split hostnames:

- `rbac-webhook.<domain>` → tls.options: `mtls-optional`
- `rbac-internal.<domain>` → tls.options: `strict-mtls`

Update DNS + Traefik router labels accordingly. Pin Traefik image digest.

## Phase 06 Step 7 — HMAC-signed cert header middleware

**Config:** [`authway/infra/authway-vps/dynamic/middleware-cert-header.yml`](../authway/infra/authway-vps/dynamic/middleware-cert-header.yml).

Chain: `strip-inbound-cert-headers` → `inject-cert-headers-passtls` → `sign-cert-header-forwardauth`.

**Cert-header-signer sidecar** — small container that reads `/run/secrets/cert_hmac` and stamps `X-Client-Cert-Sig` on the request. Skeleton left for implementation:

```
authway/infra/authway-vps/cert-header-signer/
├── Dockerfile        # FROM node:20-alpine (or Go binary)
├── server.ts         # Fastify app on :8090/sign
└── README.md
```

Signer logic (server.ts pseudocode):

```typescript
// Read PassTLSClientCert extracted CN from X-Forwarded-Tls-Client-Cert-Info
// Extract CN from PEM/subject string, HMAC-SHA256(secret, `${ts}.${cn}`)
// Return headers X-Client-Cert-CN, X-Client-Cert-Sig, X-Client-Cert-Sig-Ts
```

## Phase 06 Step 8 — Backend middleware wire-up

Middleware written: [`central-rbac/src/middleware/auth-mtls.ts`](../central-rbac/src/middleware/auth-mtls.ts).

Wire in `central-rbac/src/app.ts` (defer to Phase 06 implementation session):

```typescript
// GLOBAL default-applied per Fix #3
app.addHook('preHandler', async (req, reply) => {
  // Skip explicit opt-out routes
  if (req.url.startsWith('/webhooks/pre-token') || req.url.startsWith('/health')) return;
  // Otherwise require mTLS + JWT + crosscheck
  await verifyMtls(req, reply);
  if (reply.sent) return;
  await verifyJwt(req, reply);
  if (reply.sent) return;
  await verifyCertJwtCrosscheck(req, reply);
});
```

## Phase 06 Step 12 — Cert expiry monitoring

**Cron install:**

```bash
sudo cp /opt/authway/scripts/check-cert-expiry.sh /etc/cron.daily/
sudo chmod +x /etc/cron.daily/check-cert-expiry.sh
# Or explicit crontab (recommended for 6:00 timing):
sudo tee /etc/cron.d/cert-expiry <<'EOF'
0 6 * * * root /opt/authway/scripts/check-cert-expiry.sh >> /var/log/cert-expiry.log 2>&1
EOF
```

**Prometheus freshness alert** — add to `authway-vps` prometheus rules:

```yaml
- alert: CertExpiryCheckStale
  expr: time() - cert_expiry_check_last_success_timestamp_seconds > 172800
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Cert expiry check hasn't run in >48h on {{ $labels.host }}"
    description: "Cron job dead? Verify /opt/authway/scripts/check-cert-expiry.sh runs."

- alert: CertExpiringSoon
  expr: cert_expiry_criticals_total > 0
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "{{ $value }} cert(s) expiring in <7d on {{ $labels.host }}"
```

**Telegram fallback env:**

```bash
sudo mkdir -p /run/secrets
echo "<TELEGRAM_BOT_TOKEN>" | sudo tee /run/secrets/telegram_bot_token
sudo chmod 0400 /run/secrets/telegram_bot_token
# In cron env: export TELEGRAM_CHAT_ID=<chat-id>
```

## Phase 06 Step 10 + 10a — HTTPS termination

**Step 10 (interim step-ca-issued server cert):**

```bash
# Issue server cert for rbac.<internal-domain>
docker exec step-ca step ca certificate \
  rbac.internal.local \
  /run/step-ca/rbac-server.crt \
  /run/step-ca/rbac-server.key \
  --provisioner=admin \
  --not-after=90d

# Wire into Traefik dynamic config
```

Add step-ca root CA to admin browser OS trust store — see [OneLog trust-store install doc](TBD).

**Step 10a (Sectigo swap runbook):**

When Sectigo cert arrives:

```bash
# 1. Replace cert paths in Traefik
sudo cp sectigo.crt /etc/traefik/certs/rbac-server.crt
sudo cp sectigo.key /etc/traefik/certs/rbac-server.key

# 2. Verify no cert-pinning breaks — grep consumer configs
grep -r "spki\|pin-sha256\|thumbprint" /opt/onemcp/config /opt/portal/config

# 3. Remove step-ca root from browser trust stores (browsers now trust Sectigo chain natively)

# 4. Hot-reload Traefik (no restart)
docker exec traefik traefik reload
```

## Phase 06 Step 15 + 15.5 — Consumer rollout (dual-auth) + shared-secret removal

**Step 15 — rolling migration (Fix #1):**

Backend supports BOTH `X-Rbac-Token` AND mTLS+JWT during this window. Consumers migrate one at a time:

```bash
# Per consumer VPS:
# 1. Issue client cert
ssh authway-vps /opt/authway/scripts/issue-client-cert.sh onemcp-backend

# 2. Distribute cert
scp authway-vps:/root/.certs/clients/onemcp-backend-* onemcp-vps:/opt/onemcp/certs/

# 3. Update consumer config to send cert + drop X-Rbac-Token
# 4. Restart consumer container
ssh onemcp-vps docker compose restart onemcp-backend

# 5. Verify: grep central-rbac logs — see mTLS+JWT hits, no X-Rbac-Token from this consumer
docker logs central-rbac --since 5m | grep -E "onemcp-backend|X-Rbac-Token"
```

**Step 15.5 — shared-secret removal (only after all consumers migrated + 48h verified):**

```bash
# 1. Verify zero X-Rbac-Token hits in prod logs for 7 consecutive days
docker logs central-rbac --since 168h | grep -c "X-Rbac-Token" # should be 0

# 2. Git tag freeze anchor (already created in Step 12.5)
git log --oneline pre-phase06-freeze -1

# 3. Remove shared-secret code path from auth-resolve.ts (Mode 1 branch)
# 4. Deploy
# 5. Verify /v1/resolve still works via mTLS+JWT
```

**Rollback (if Step 15.5 breaks something):**

```bash
git reset --hard pre-phase06-freeze
docker compose up -d central-rbac
```

## Verify checklist (end of Phase 06)

- [ ] Step 0 PoC 3 deliverables verified on lab
- [ ] step-ca root_ca_key Age-encrypted + offline stored, plaintext shredded
- [ ] Traefik 2-TLS-options matrix passes on lab (or fallback split hostnames applied)
- [ ] HMAC secret v1 created via `docker secret create`; rotation cron scheduled
- [ ] All 3 SA client certs issued (onemcp-backend, portal-admin, central-rbac-webhook)
- [ ] Backend `auth-mtls.ts` wired globally + explicit opt-outs for webhook/health
- [ ] Cert expiry cron runs daily; Prometheus scrapes textfile; alerts fire on staleness
- [ ] Interim step-ca-issued server cert deployed for HTTPS
- [ ] Consumers migrated to mTLS+JWT (one at a time, verified 48h each)
- [ ] Shared-secret code path removed (Step 15.5), tag `pre-phase06-freeze` intact
- [ ] Sectigo swap runbook tested on lab (Step 10a)

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Traefik reload fails with `caFiles: no such file` | step-ca sidecar not healthy before Traefik started | Verify `depends_on: step-ca: {condition: service_healthy}` in compose |
| 401 on `/v1/resolve` with valid cert | HMAC secret mismatch (rotation overlap gap) | Check both `/run/secrets/cert_hmac` + `/run/secrets/cert_hmac_prev` mounted |
| `openssl s_client` handshake fails on strict-mtls path | Cert not signed by intermediate | Re-issue via `issue-client-cert.sh` |
| Alert flood on cron heartbeat | Cron dead → textfile stale | Check `/var/log/cert-expiry.log`; verify cron.d permissions |
| Cert CN mismatches JWT sub → 403 | SA cert issued with wrong CN | CN must equal Zitadel SA snowflake ID; check `zitadel-jwt-verify-pitfalls.md` memory |

## Unresolved

- Cert-header-signer sidecar implementation — skeleton only, needs container image build
- Backend `app.ts` global middleware wire-up — deferred to Phase 06 impl session
- `docker secret cert_hmac_v1` initial creation — must run manually before first deploy
- Prometheus scrape target for `authway-vps` node_textfile — verify already scraped by onelog Prometheus

## References

- Plan: [phase-06-security-foundation.md](../plans/260826-1644-central-rbac-hardening-and-self-service/phase-06-security-foundation.md)
- Red team findings: [red-team-260826-1644-central-rbac-hardening-findings.md](../plans/reports/red-team-260826-1644-central-rbac-hardening-findings.md)
- Memory: `alertmanager-config-reload.md`, `zitadel-jwt-verify-pitfalls.md`, `web-crypto-secure-context.md`
