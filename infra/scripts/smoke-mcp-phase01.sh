#!/usr/bin/env bash
# Smoke test Phase 01: mcp-semantic + mcp-vl behind Caddy with Bearer gate.
#
# Prereqs:
#   1. Docker Desktop running.
#   2. .env contains: QDRANT_API_KEY, POSTGRES_USER/PASSWORD, EMBED_MOCK=true
#      (optional for offline test).
#   3. Caddy reverse proxy host resolves to 127.0.0.1 (e.g. add `app.local` to
#      hosts file). For loopback testing pass BASE=http://127.0.0.1 instead.
#
# Usage:
#   cd infra && ./scripts/smoke-mcp-phase01.sh
#   BASE=http://127.0.0.1 ./scripts/smoke-mcp-phase01.sh   # bypass app.local
#
# Exits non-zero on first failure; emits friendly messages otherwise.
set -euo pipefail

BASE="${BASE:-http://app.local}"
TOKEN_USER="smoke"
TOKEN="sk-mcp-smoke-$(date +%s%N | sha256sum | cut -c1-32 2>/dev/null || echo deadbeef)"

cd "$(dirname "$0")/.."

echo "▶ Writing temp .env additions (MCP_BEARER_TOKENS, VMUI_BASE_URL)"
grep -v '^MCP_BEARER_TOKENS=' .env > .env.smoke.bak 2>/dev/null || true
cp .env .env.smoke.bak 2>/dev/null || touch .env.smoke.bak
{
  cat .env.smoke.bak | grep -v '^MCP_BEARER_TOKENS=' | grep -v '^VMUI_BASE_URL=' | grep -v '^MCP_ALLOW_ANON='
  echo "MCP_BEARER_TOKENS=${TOKEN_USER}:${TOKEN}"
  echo "VMUI_BASE_URL=${BASE}"
  echo "MCP_ALLOW_ANON=false"
  echo "EMBED_MOCK=true"
} > .env

echo "▶ Bringing up qdrant + victorialogs + mcp-semantic + mcp-vl + caddy"
docker compose up -d qdrant victorialogs mcp-semantic mcp-vl caddy
echo "▶ Waiting 10s for containers to settle"
sleep 10

assert_status() {
  local desc="$1" url="$2" expected="$3"
  shift 3
  local got
  got=$(curl -s -o /dev/null -w "%{http_code}" "$@" "$url")
  if [[ "$got" == "$expected" ]]; then
    echo "✓ $desc → $got"
  else
    echo "✗ $desc → $got (expected $expected)"
    echo "  url=$url"
    return 1
  fi
}

echo
echo "═ Test 1: /healthz (no auth)"
assert_status "GET /healthz" "$BASE/mcp/semantic/healthz" 200 \
  || assert_status "GET healthz direct" "http://127.0.0.1:9002/healthz" 200

echo
echo "═ Test 2: /auth/verify without Bearer → 401 (fail-closed)"
assert_status "GET /auth/verify (no header)" "$BASE/mcp/semantic/sse" 401

echo
echo "═ Test 3: /auth/verify with invalid Bearer → 401"
assert_status "GET /mcp/semantic/sse (bad bearer)" "$BASE/mcp/semantic/sse" 401 \
  -H "Authorization: Bearer sk-bogus"

echo
echo "═ Test 4: /mcp/semantic/sse with valid Bearer → 200 (SSE upgrade)"
# SSE returns 200 + content-type text/event-stream — we just check the status.
assert_status "GET /mcp/semantic/sse (valid)" "$BASE/mcp/semantic/sse" 200 \
  -H "Authorization: Bearer $TOKEN"

echo
echo "═ Test 5: /mcp/vl/sse with valid Bearer → 200 (proxied to mcp-vl)"
assert_status "GET /mcp/vl/sse (valid)" "$BASE/mcp/vl/sse" 200 \
  -H "Authorization: Bearer $TOKEN"

echo
echo "═ Test 6: audit log file has entries"
if docker compose exec -T mcp-semantic test -s /var/log/onelog-audit/mcp-semantic.log; then
  echo "✓ audit file non-empty"
  docker compose exec -T mcp-semantic tail -n 5 /var/log/onelog-audit/mcp-semantic.log
else
  echo "✗ audit file missing or empty"
  exit 1
fi

echo
echo "Smoke complete. User: ${TOKEN_USER} Token: ${TOKEN}"
echo "Restore: cp infra/.env.smoke.bak infra/.env"
