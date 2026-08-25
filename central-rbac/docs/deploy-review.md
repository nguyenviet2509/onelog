# Deploy Runbook — Central RBAC Review Stack

Review URL: `http://10.200.0.125:8082/` (LAN/VPN/SSH tunnel only)

## Prerequisites

- SSH access to authway-vps
- `BREAK_GLASS_USER_ID` already set in `/opt/central-rbac/.env` (Phase 2)
- `ZITADEL_PROJECT_ID` and `ZITADEL_SA_PAT` set in `/opt/central-rbac/.env`
- Source repo at `/opt/central-rbac/` and `/opt/central-rbac-ui/` on authway-vps
- authway-prod Traefik + Zitadel already running

---

## Deploy Steps

### 1. Pull latest code

```bash
ssh authway-vps
cd /opt/central-rbac && git pull origin master
cd /opt/central-rbac-ui && git pull origin master
```

### 2. Patch Traefik entrypoint

Edit `/opt/authway/infra/authway-vps/traefik.yml` — add `rbac-review` entrypoint:

```yaml
entryPoints:
  web:
    address: ":80"
  rbac-review:
    address: ":8082"
```

Edit `authway-prod docker-compose.yml` — add port to traefik service:

```yaml
ports:
  - "0.0.0.0:80:80"
  - "10.200.0.125:8082:8082"
```

Reload Traefik:

```bash
cd /opt/authway/infra/authway-vps
docker compose up -d traefik
```

### 3. Seed permissions + roles

```bash
cd /opt/central-rbac
# Dry-run first
BOOTSTRAP_DRY_RUN=true npx tsx scripts/bootstrap.ts

# Apply if dry-run passes
npx tsx scripts/bootstrap.ts
```

### 4. Build UI image

```bash
cd /opt/central-rbac-ui
docker build \
  --build-arg VITE_API_BASE_URL=/v1 \
  --build-arg VITE_ZITADEL_ISSUER=https://10.200.0.125 \
  --build-arg VITE_ZITADEL_CLIENT_ID=<spa-client-id-from-zitadel> \
  --build-arg VITE_ZITADEL_REDIRECT_URI=http://10.200.0.125:8082/callback \
  --build-arg VITE_REVIEW_MODE=true \
  -t central-rbac-ui:phase04 .
```

### 5. Start UI container

```bash
# Load UI env from running backend env file for convenience
export $(grep -v '^#' /opt/central-rbac/.env | xargs)

docker run -d \
  --name central-rbac-ui \
  --restart unless-stopped \
  --network authway-prod_edge \
  --expose 80 \
  --label "traefik.enable=true" \
  --label "traefik.docker.network=authway-prod_edge" \
  --label "traefik.http.routers.central-rbac-ui.rule=Host(\`10.200.0.125\`)" \
  --label "traefik.http.routers.central-rbac-ui.entrypoints=rbac-review" \
  --label "traefik.http.routers.central-rbac-ui.priority=100" \
  --label "traefik.http.services.central-rbac-ui.loadbalancer.server.port=80" \
  central-rbac-ui:phase04
```

> **Note (H7 fix):** `docker-compose.review.yml` was removed because its `central-rbac`
> service block listed only `authway-prod_edge` network. Running `docker compose up -d` would
> reconcile the container and detach it from `central-rbac-postgres` / `central-rbac-redis`
> networks, breaking DB + Redis. Use `docker network connect` (step 6) instead — it adds a
> network without touching existing ones.

### 6. Attach central-rbac backend to edge network

```bash
# Adds authway-prod_edge without detaching existing DB/Redis networks
docker network connect authway-prod_edge central-rbac

# Add Traefik labels to existing container
docker container update \
  --label-add "traefik.enable=true" \
  --label-add "traefik.docker.network=authway-prod_edge" \
  --label-add "traefik.http.routers.central-rbac-api.rule=Host(\`10.200.0.125\`) && PathPrefix(\`/v1\`)" \
  --label-add "traefik.http.routers.central-rbac-api.entrypoints=rbac-review" \
  --label-add "traefik.http.routers.central-rbac-api.priority=200" \
  --label-add "traefik.http.services.central-rbac-api.loadbalancer.server.port=3000" \
  central-rbac
```

### 7. Verify

```bash
# API health
curl -s http://10.200.0.125:8082/v1/health | jq .

# UI serves (200 or redirect to login)
curl -sI http://10.200.0.125:8082/

# Container status + networks
docker inspect central-rbac --format '{{json .NetworkSettings.Networks}}' | jq 'keys'
```

---

## Rollback

```bash
# Stop UI container
docker stop central-rbac-ui && docker rm central-rbac-ui

# Detach backend from edge network (does NOT touch DB/Redis networks)
docker network disconnect authway-prod_edge central-rbac

# Revert Traefik port (remove 10.200.0.125:8082:8082 from authway-prod compose)
# then reload:
cd /opt/authway/infra/authway-vps && docker compose up -d traefik
```

---

## Post-Review: Swap to Domain (Step 17.5)

After review sign-off, to promote to `https://rbac.inet.vn`:

1. Obtain Sectigo cert for `rbac.inet.vn` — see `docs/tls-sectigo.md` (post-review task)
2. Add `rbac-prod` Traefik entrypoint on `:443` with TLS config
3. Update `CENTRAL_RBAC_CORS_ORIGIN` env to `https://rbac.inet.vn`
4. Rebuild UI image with `VITE_ZITADEL_REDIRECT_URI=https://rbac.inet.vn/callback`
5. Update Zitadel SPA app redirect URIs to include new domain
6. Replace `docker-compose.review.yml` labels `Host(10.200.0.125)` → `Host(rbac.inet.vn)`

---

## Deferred (post-review)

- TLS cert provisioning (Step 17.5)
- `verify-restore.sh` quarterly script
- VictoriaLogs alert rules for RBAC errors
- OneMCP portal integration
- CODEOWNERS + branch protection
- `rotate-break-glass.ts`
