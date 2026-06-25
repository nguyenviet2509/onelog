#!/usr/bin/env bash
# Shared helpers for rsyslog E2E scenario scripts.
# Source via:  . "$(dirname "$0")/../lib/common.sh"

ONELOG_HOST="${ONELOG_HOST:-127.0.0.1}"
ONELOG_JSON_PORT="${ONELOG_JSON_PORT:-6515}"
VL_URL="${VL_URL:-http://127.0.0.1:9428}"
NATS_URL="${NATS_URL:-nats://127.0.0.1:4222}"
CONTAINER="${CONTAINER:-onelog-e2e-rsyslog-client}"

vl_query() {
  # $1 = LogsQL query string
  curl -sS "${VL_URL}/select/logsql/query" --data-urlencode "query=$1"
}

vl_count() {
  vl_query "$1" | grep -c . || true
}

send_json_event() {
  # $1 = single-line JSON
  printf '%s\n' "$1" | nc -q1 "$ONELOG_HOST" "$ONELOG_JSON_PORT"
}

send_syslog_udp() {
  # $1 = tag, $2 = message, $3 = priority (default user.info)
  local tag="$1" msg="$2" pri="${3:-user.info}"
  logger -n "$ONELOG_HOST" -P 514 -d -t "$tag" -p "$pri" "$msg"
}

send_syslog_tcp() {
  local tag="$1" msg="$2" pri="${3:-user.info}"
  logger -n "$ONELOG_HOST" -P 6514 -T -t "$tag" -p "$pri" "$msg"
}

assert_eq() {
  # $1 actual, $2 expected, $3 label
  if [ "$1" != "$2" ]; then
    echo "FAIL [$3]: got=$1 expect=$2" >&2
    return 1
  fi
  echo "OK   [$3] (=${1})"
}

assert_ge() {
  if [ "$1" -lt "$2" ]; then
    echo "FAIL [$3]: got=$1 expect>=$2" >&2
    return 1
  fi
  echo "OK   [$3] (>=${2}, got ${1})"
}

iso_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
