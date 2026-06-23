#!/usr/bin/env bash
# Healthcheck for ragstack — runs from the logserver itself
# Usage: bash healthcheck.sh
# Exit 0 = all OK, non-zero = at least one component failed.

set -u

# Default: thư mục chứa script (giả định scripts/ nằm trong infra/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${INFRA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
if [[ -f "$INFRA_DIR/.env" ]]; then
  set -a; . "$INFRA_DIR/.env"; set +a
fi

FAIL=0
ok()   { printf "  \033[32mOK\033[0m  %s\n" "$1"; }
fail() { printf "  \033[31mFAIL\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }

echo "== ragstack healthcheck =="

# VictoriaLogs
if curl -fsS -m 3 http://127.0.0.1:9428/health >/dev/null; then
  ok "victorialogs http://127.0.0.1:9428/health"
else
  fail "victorialogs unhealthy"
fi

# Qdrant
if curl -fsS -m 3 http://127.0.0.1:6333/healthz >/dev/null; then
  ok "qdrant http://127.0.0.1:6333/healthz"
else
  fail "qdrant unhealthy"
fi

# Postgres
if docker exec ragstack-postgres pg_isready -U "${POSTGRES_USER:-rag}" >/dev/null 2>&1; then
  ok "postgres pg_isready"
else
  fail "postgres not ready"
fi

# Redis (only if running — profile=agent)
if docker ps --format '{{.Names}}' | grep -q '^ragstack-redis$'; then
  # REDISCLI_AUTH tránh password lộ trong `ps`
  if docker exec -e REDISCLI_AUTH="${REDIS_PASSWORD:-}" ragstack-redis \
       redis-cli --no-auth-warning ping 2>/dev/null | grep -q PONG; then
    ok "redis ping"
  else
    fail "redis ping failed"
  fi
fi

# Vector
if curl -fsS -m 3 http://127.0.0.1:8686/health >/dev/null; then
  ok "vector api http://127.0.0.1:8686/health"
else
  fail "vector api unhealthy"
fi

# Caddy (port 80 returns 403 on non-allowed IP, but service alive — KHÔNG dùng -f)
CADDY_CODE=$(curl -sS -o /dev/null -m 3 -w "%{http_code}" http://127.0.0.1:80 || echo "000")
if [[ "$CADDY_CODE" =~ ^(200|301|302|403|404)$ ]]; then
  ok "caddy listening on :80 (HTTP $CADDY_CODE)"
else
  fail "caddy not responding on :80 (HTTP $CADDY_CODE)"
fi

# Disk
USED=$(df -P "$INFRA_DIR" 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5}')
if [[ -n "${USED:-}" && "$USED" -lt 85 ]]; then
  ok "disk ${USED}% used on $(df -P "$INFRA_DIR" | awk 'NR==2{print $6}')"
else
  fail "disk ${USED:-?}% used — investigate"
fi

echo "== result: $FAIL failure(s) =="
exit "$FAIL"
