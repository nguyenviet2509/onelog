#!/usr/bin/env bash
# Poll LLM provider balance/cost APIs → emit JSON via syslog.
# Cron: */15 * * * * root ENV_FILE=/root/onelog/infra/litellm/.env.cost \
#         bash /root/onelog/infra/scripts/poll-provider-cost.sh \
#         >> /var/log/onelog-provider-cost.log 2>&1
#
# Fail-soft: each provider block is independent — one failure does NOT abort
# the rest. Script always exits 0 (except: missing jq → exit 2).
# Env: source from ENV_FILE; chmod 0400 root:root on the real file.

set -uo pipefail
# NOTE: intentionally no `set -e`. Fail-soft requires individual error handling
# per provider block instead of global abort on first failure.

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
command -v jq >/dev/null 2>&1 || { echo "[poll-provider-cost] ERROR: jq required — apt install jq" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "[poll-provider-cost] ERROR: curl required" >&2; exit 2; }
command -v logger >/dev/null 2>&1 || { echo "[poll-provider-cost] ERROR: logger (util-linux) required" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Load credentials
# ---------------------------------------------------------------------------
# Portable default: derive from script location (infra/scripts/ → infra/litellm/).
# Override via ENV_FILE env var if cron env sets HOME differently or path moves.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../litellm/.env.cost}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[poll-provider-cost] ERROR: env file not found: $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------
TS=$(date -u -Is)

# emit: merge provider fields with standard metadata, emit via syslog.
# Args: $1=provider_name  $2=JSON_object_string (from jq)
emit() {
  local provider="$1" payload="$2"
  # Validate jq produced an object before emitting (guard against null/empty).
  if [[ -z "$payload" ]] || ! echo "$payload" | jq -e . >/dev/null 2>&1; then
    warn "$provider" "jq produced invalid/empty JSON — skipping emit"
    return
  fi
  local msg
  msg=$(echo "$payload" | jq -c \
    --arg ts  "$TS" \
    --arg svc "provider_cost" \
    --arg p   "$provider" \
    '. + {_time: $ts, service: $svc, provider: $p}')
  # logger: tag=provider_cost → rsyslog routes to Vector :6514.
  # -t sets the syslog tag (appname). Message must NOT contain raw API keys.
  logger -t provider_cost "$msg"
}

# warn: emit a plain syslog warning for failed provider (user.warn facility).
# Args: $1=provider_name  $2=reason_string
warn() {
  local provider="$1" reason="$2"
  logger -t provider_cost -p user.warn \
    "provider=${provider} status=fail msg=\"${reason}\""
}

# curl_api: thin wrapper enforcing timeout + silent mode.
# Returns curl exit code; caller decides how to handle failure.
curl_api() {
  curl -fsS --max-time 10 "$@"
}

# ---------------------------------------------------------------------------
# Provider: DeepSeek — /user/balance
# API ref: https://api-docs.deepseek.com/ (balance endpoint, no date filter)
# ---------------------------------------------------------------------------
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
if [[ -z "$DEEPSEEK_API_KEY" ]]; then
  warn deepseek "DEEPSEEK_API_KEY not set in $ENV_FILE"
else
  resp=$(curl_api "https://api.deepseek.com/user/balance" \
    -H "Authorization: Bearer ${DEEPSEEK_API_KEY}") && rc=$? || rc=$?
  if [[ $rc -ne 0 ]]; then
    warn deepseek "curl failed (exit $rc)"
  else
    parsed=$(echo "$resp" | jq -e '{
      balance_usd: (.balance_infos[0].total_balance    | tonumber),
      granted_usd: (.balance_infos[0].granted_balance  | tonumber),
      topped_up_usd: (.balance_infos[0].topped_up_balance | tonumber)
    }' 2>/dev/null) && jq_rc=$? || jq_rc=$?
    if [[ $jq_rc -ne 0 ]]; then
      warn deepseek "jq parse failed — unexpected response shape"
    else
      emit deepseek "$parsed"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Provider: OpenAI — /v1/organization/costs (last 24 h)
# API ref: https://platform.openai.com/docs/api-reference/costs
# Requires Admin API key with scope: costs.read
# ---------------------------------------------------------------------------
OPENAI_ADMIN_KEY="${OPENAI_ADMIN_KEY:-}"
if [[ -z "$OPENAI_ADMIN_KEY" ]]; then
  warn openai "OPENAI_ADMIN_KEY not set in $ENV_FILE"
else
  START=$(date -u -d 'yesterday' +%s 2>/dev/null) || START=$(date -u -v-1d +%s 2>/dev/null) || {
    warn openai "date command failed to compute yesterday epoch"
    START=""
  }
  if [[ -n "$START" ]]; then
    resp=$(curl_api \
      "https://api.openai.com/v1/organization/costs?start_time=${START}" \
      -H "Authorization: Bearer ${OPENAI_ADMIN_KEY}") && rc=$? || rc=$?
    if [[ $rc -ne 0 ]]; then
      warn openai "curl failed (exit $rc)"
    else
      parsed=$(echo "$resp" | jq -e '{
        cost_usd_day: ([.data[].amount.value]   | add // 0),
        currency:     (.data[0].amount.currency // "usd")
      }' 2>/dev/null) && jq_rc=$? || jq_rc=$?
      if [[ $jq_rc -ne 0 ]]; then
        warn openai "jq parse failed — unexpected response shape"
      else
        emit openai "$parsed"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Provider: Anthropic — /v1/organizations/usage_report/messages (last 24 h)
# API ref: https://docs.anthropic.com/en/api/usage-reports
# Requires Admin API key from org console.
# ---------------------------------------------------------------------------
ANTHROPIC_ADMIN_KEY="${ANTHROPIC_ADMIN_KEY:-}"
if [[ -z "$ANTHROPIC_ADMIN_KEY" ]]; then
  warn anthropic "ANTHROPIC_ADMIN_KEY not set in $ENV_FILE"
else
  # ISO-8601 date for yesterday (UTC). GNU date and BSD date handled.
  YESTERDAY=$(date -u -d 'yesterday' -Is 2>/dev/null) || \
    YESTERDAY=$(date -u -v-1d -Is 2>/dev/null) || {
      warn anthropic "date command failed to compute yesterday timestamp"
      YESTERDAY=""
    }
  if [[ -n "$YESTERDAY" ]]; then
    resp=$(curl_api \
      "https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=${YESTERDAY}" \
      -H "x-api-key: ${ANTHROPIC_ADMIN_KEY}" \
      -H "anthropic-version: 2023-06-01") && rc=$? || rc=$?
    if [[ $rc -ne 0 ]]; then
      warn anthropic "curl failed (exit $rc)"
    else
      parsed=$(echo "$resp" | jq -e '{
        tokens_in:    ([.data[].usage.input_tokens]           | add // 0),
        tokens_out:   ([.data[].usage.output_tokens]          | add // 0),
        cache_read:   ([.data[].usage.cache_read_input_tokens]| add // 0),
        cost_usd_day: ([.data[].cost.amount]                  | add // 0)
      }' 2>/dev/null) && jq_rc=$? || jq_rc=$?
      if [[ $jq_rc -ne 0 ]]; then
        warn anthropic "jq parse failed — unexpected response shape"
      else
        emit anthropic "$parsed"
      fi
    fi
  fi
fi

exit 0
