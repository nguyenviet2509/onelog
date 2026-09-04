# authway-vps Deploy Report
Date: 2026-08-07 | Agent: fullstack-developer

## Status: DONE

---

## Files Created

| File | Notes |
|------|-------|
| `infra/authway-vps/docker-compose.yml` | HTTP-only, traefik:3.7, network alias `authway-vps.local` |
| `infra/authway-vps/traefik.yml` | web:80 only, no websecure, no redirect |
| `infra/authway-vps/dynamic/middlewares.yml` | No HSTS, ipallowlist includes 10.200.0.0/24 |
| `infra/authway-vps/zitadel-config.yaml` | TLS.Enabled=false, same as lab |
| `infra/authway-vps/zitadel-steps.yaml` | admin email changed to admin@authway-vps.local |
| `infra/authway-vps/.env.example` | Template with openssl rand instructions |
| `infra/authway-vps/.env` | Real creds — NOT committed (covered by .gitignore) |
| `infra/authway-vps/scripts/{render-config,check-health,backup-postgres}.sh` | Copied from auth-vps |
| `infra/authway-vps/README.md` | Full deploy runbook |
| `.gitignore` | Created (none existed); ignores `infra/*/.env`, `*.runtime.yaml`, `tls/` |

Git commit: `e40c1e8` — `feat(infra): add authway-vps prod deploy (HTTP-only, IP-as-domain 10.200.0.125)`

---

## Admin Credentials (one-time show — save now)

```
ZITADEL_ADMIN_USERNAME: zitadel-admin
ZITADEL_ADMIN_PASSWORD: oLPbemU1fRqi/AAD7a1d7XCu1nKc9i9Z
ZITADEL_MASTERKEY:      cd6321f83ea5a1bbe59f594252e58027
```

Console URL: http://10.200.0.125/ui/console/

First login will require password change (PasswordChangeRequired=true).

---

## Egress IP (for Zimbra CSF whitelist)

```
103.57.222.245
```

This IP is already in the authway-vps ipallowlist (`103.57.222.245/32`) — so authway-vps can call out
to itself and be routed correctly. Anh needs to whitelist this IP on the Zimbra CSF firewall to allow
authway-vps → Zimbra LDAP (103.57.220.98:389).

---

## Verify Output

```
=== Container Status ===
authway-prod-mailhog-1         Up (healthy)    127.0.0.1:8025->8025/tcp
authway-prod-postgres-1        Up (healthy)    5432/tcp (internal only)
authway-prod-traefik-1         Up              0.0.0.0:80->80/tcp, 127.0.0.1:8088->8080/tcp
authway-prod-zitadel-1         Up (healthy)    8080/tcp (internal only)
authway-prod-zitadel-login-1   Up (healthy)    3000/tcp (internal only)

=== /debug/ready        → HTTP/1.1 200 OK  ("ok")
=== /ui/console/        → HTTP/1.1 200 OK
=== /ui/v2/login/healthy → HTTP/1.1 200 OK
```

---

## Issues Encountered

### Traefik Docker Provider Incompatibility (resolved)

**Problem:** Traefik v3.2 and v3.3 bundle a Docker SDK that sends `?version=1.24` on initial ping.
Docker Engine 29.7.2 (installed from official repo, built 2026-08-05) raised `minAPIVersion=1.40`
and rejects the connection. `DOCKER_API_VERSION=1.43` env var does not override the bundled SDK.

**Fix:** Upgraded Traefik to `3.7` (latest stable) which ships with updated Docker SDK compatible
with Docker Engine 29+. The `auth-vps` lab still runs Docker 20.x where Traefik v3.2 works fine.

**Impact on local config:** `docker-compose.yml` uses `traefik:3.7` instead of `traefik:v3.2`.
The lab `infra/auth-vps/docker-compose.yml` was NOT changed (lab uses older Docker daemon).

---

## Next Steps for User

### 1. Whitelist authway-vps egress IP on Zimbra CSF
SSH into zimbra-mail, add to CSF whitelist:
```
103.57.222.245
```
This unblocks authway-vps → `ldap://103.57.220.98:389` for LDAP IdP.

### 2. First Login + Password Change
- Open: http://10.200.0.125/ui/console/
- Login: `zitadel-admin` / `oLPbemU1fRqi/AAD7a1d7XCu1nKc9i9Z`
- System forces password change — set a strong new password and record it

### 3. Configure Zimbra LDAP IdP
Follow checklist in `authway/plans/260806-0939-zitadel-ldap-zimbra-lab/completion-notes.md`.
Key values:
- LDAP URL: `ldap://103.57.220.98:389`
- Bind DN: `uid=zitadel-bind,ou=people,dc=zimbra8815,dc=inet,dc=name,dc=vn`
- Bind password: `/EHNOQ98k/mXpVVv7b2IXAeVZwqXh1A8`

### 4. Ops
- Traefik dashboard (SSH tunnel): `ssh -L 8088:localhost:8088 -p 24700 root@10.200.0.125` → http://localhost:8088
- Mailhog (SSH tunnel): `ssh -L 8025:localhost:8025 -p 24700 root@10.200.0.125` → http://localhost:8025
- Backup: `bash /opt/authway/infra/authway-vps/scripts/backup-postgres.sh`

---

## Unresolved Questions
- None blocking. TLS upgrade path documented in README when domain is ready.
