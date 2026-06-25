#!/usr/bin/env bash
# D. Severity routing — VL gets all severities; NATS logs.warn only WARN+.
# Requires `nats` CLI: https://github.com/nats-io/natscli
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"

TAG="sev-$(date +%s)"
echo "=== D. Severity routing (TAG=$TAG) ==="

if ! command -v nats >/dev/null 2>&1; then
  echo "SKIP: nats CLI not installed (https://github.com/nats-io/natscli)"
  exit 0
fi

NATS_OUT=$(mktemp)
trap 'rm -f "$NATS_OUT"; kill $NATS_PID 2>/dev/null || true' EXIT

nats sub -s "$NATS_URL" "logs.warn" --raw > "$NATS_OUT" &
NATS_PID=$!
sleep 1

# 8 severities total. WARN+ = warning/err/crit/alert/emerg (5).
for sev in info debug notice warning err crit alert emerg; do
  send_json_event "{\"@timestamp\":\"$(iso_now)\",\"host\":{\"name\":\"d\"},\"log\":{\"level\":\"$sev\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"sev test $sev\"}"
done
sleep 3
kill $NATS_PID 2>/dev/null || true
wait $NATS_PID 2>/dev/null || true

assert_eq "$(vl_count "service:$TAG")" "8" "D VL gets all 8 severities"

nats_count=$(grep -c "\"service\":\"$TAG\"" "$NATS_OUT" || echo 0)
assert_eq "$nats_count" "5" "D NATS gets only WARN+"

for low in info debug notice; do
  c=$(grep -c "\"_msg\":\"sev test $low\"" "$NATS_OUT" || echo 0)
  assert_eq "$c" "0" "D NATS excludes $low"
done

echo "=== D PASS ==="
