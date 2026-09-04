#!/bin/bash
# smoke-oidc.sh — verify Authway Zitadel + OneLog IAP OIDC flow health.
#
# Exit 0 = healthy; exit 1 = regression detected.
# Chạy sau bất kỳ thay đổi Traefik middleware / Zitadel env / Grafana OIDC.
#
# Usage: ./smoke-oidc.sh [--verbose]
#
# Overrides:
#   ZITADEL_HOST   default 10.200.0.125
#   GRAFANA_HOST   default 10.200.0.30
#
# Check 3 (Traefik middleware wiring) yêu cầu SSH authway-vps đã có key.
# Nếu SSH fail → skip check 3, các check khác vẫn cover regression phổ biến.
#
# Ref: onelog plan 260904-0951-authway-gitlab-sso-prod-hardening phase 2
set -uo pipefail

ZITADEL_HOST="${ZITADEL_HOST:-10.200.0.125}"
GRAFANA_HOST="${GRAFANA_HOST:-10.200.0.30}"
VERBOSE=0
[[ "${1:-}" == "--verbose" ]] && VERBOSE=1

FAIL=0
log() { echo "[$(date +%H:%M:%S)] $*"; }
ok()   { log "OK   — $*"; }
fail() { log "FAIL — $*"; FAIL=1; }
dbg()  { [[ $VERBOSE -eq 1 ]] && log "DBG  — $*"; return 0; }

# --- Check 1: Zitadel discovery issuer khớp EXTERNAL_DOMAIN ---
DISCOVERY=$(curl -s -m 5 "http://${ZITADEL_HOST}/.well-known/openid-configuration" 2>/dev/null || echo "")
if [[ -z "$DISCOVERY" ]]; then
  fail "Zitadel discovery unreachable at http://${ZITADEL_HOST}"
else
  ISSUER=$(echo "$DISCOVERY" | grep -oE '"issuer":"[^"]+"' | cut -d'"' -f4)
  dbg "issuer=$ISSUER"
  if [[ "$ISSUER" == "http://${ZITADEL_HOST}" ]]; then
    ok "Zitadel discovery issuer=$ISSUER"
  else
    fail "Zitadel discovery issuer mismatch: got '$ISSUER', expected 'http://${ZITADEL_HOST}'"
  fi
fi

# --- Check 2: strip-hsts-login middleware active on /ui/v2/login/* ---
HSTS=$(curl -sI -m 5 "http://${ZITADEL_HOST}/ui/v2/login/loginname" 2>/dev/null \
  | grep -i "strict-transport-security" || true)
if [[ -z "$HSTS" ]]; then
  ok "HSTS header stripped on /ui/v2/login/* (strip-hsts-login active)"
else
  fail "HSTS header present on login: $HSTS (strip-hsts-login middleware missing?)"
fi

# --- Check 3: Traefik router middleware wiring (fix-idps-scheme + strip-hsts-login) ---
TRAEFIK_ROUTERS=$(ssh -o BatchMode=yes -o ConnectTimeout=5 authway-vps \
  'curl -s http://127.0.0.1:8088/api/http/routers' 2>/dev/null || echo "")
if [[ -z "$TRAEFIK_ROUTERS" ]]; then
  log "SKIP — Traefik API unreachable via ssh authway-vps (add key or run from VPS)"
else
  if echo "$TRAEFIK_ROUTERS" | grep -q "fix-idps-scheme@file"; then
    ok "Traefik router 'zitadel' has fix-idps-scheme@file middleware"
  else
    fail "Traefik router 'zitadel' missing fix-idps-scheme@file middleware"
  fi
  if echo "$TRAEFIK_ROUTERS" | grep -q "strip-hsts-login"; then
    ok "Traefik router 'zitadel-login' has strip-hsts-login middleware"
  else
    fail "Traefik router 'zitadel-login' missing strip-hsts-login middleware"
  fi
fi

# --- Check 4: Grafana OIDC redirect_uri khớp GF_SERVER_ROOT_URL ---
LOGIN_REDIR=$(curl -sI -m 5 "http://${GRAFANA_HOST}/grafana/login/generic_oauth" 2>/dev/null \
  | grep -i "^location:" | tr -d '\r' || true)
dbg "grafana login redirect: $LOGIN_REDIR"
EXPECTED_RU="redirect_uri=http%3A%2F%2F${GRAFANA_HOST}%2Fgrafana%2Flogin%2Fgeneric_oauth"
if echo "$LOGIN_REDIR" | grep -q "$EXPECTED_RU"; then
  ok "Grafana redirect_uri emits http://${GRAFANA_HOST}/grafana/login/generic_oauth"
else
  fail "Grafana redirect_uri mismatch — check GF_SERVER_ROOT_URL env"
  dbg "  raw Location: $LOGIN_REDIR"
fi

# --- Check 5: Zitadel JWKS reachable (backend JWT verify path) ---
JWKS=$(curl -s -m 5 "http://${ZITADEL_HOST}/oauth/v2/keys" 2>/dev/null || echo "")
if echo "$JWKS" | grep -q '"keys"'; then
  ok "Zitadel JWKS endpoint returns keys"
else
  fail "Zitadel JWKS endpoint unreachable or empty"
fi

echo ""
if [[ $FAIL -eq 0 ]]; then
  log "SMOKE PASS — Authway SSO healthy"
  exit 0
else
  log "SMOKE FAIL — see [FAIL] lines above"
  exit 1
fi
