#!/usr/bin/env bash
# C. PII redaction matrix — 6 patterns: email, priv_ip, jwt, aws_key, bearer, password.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"

TAG="pii-$(date +%s)"
TS="$(iso_now)"
echo "=== C. PII redaction matrix (TAG=$TAG) ==="

# Patterns: each event carries one PII type in message body.
declare -A raw=(
  ["email"]="user admin@example.com login"
  ["priv_ip"]="connect from 192.168.1.50"
  ["jwt"]="token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_xyz123"
  ["aws_key"]="AKIAIOSFODNN7EXAMPLE found"
  ["bearer"]="Authorization: Bearer abc123token"
  ["password"]="login password=secret123 ok"
)
declare -A marker=(
  ["email"]="<EMAIL>"
  ["priv_ip"]="<PRIV_IP>"
  ["jwt"]="<JWT>"
  ["aws_key"]="<AWS_KEY>"
  ["bearer"]="<TOKEN>"
  ["password"]="<REDACTED>"
)
declare -A leak=(
  ["email"]="admin@example.com"
  ["priv_ip"]="192.168.1.50"
  ["jwt"]="eyJhbGciOiJIUzI1NiJ9"
  ["aws_key"]="AKIAIOSFODNN7EXAMPLE"
  ["bearer"]="abc123token"
  ["password"]="secret123"
)

for k in "${!raw[@]}"; do
  send_json_event "{\"@timestamp\":\"$TS\",\"host\":{\"name\":\"c-$k\"},\"log\":{\"level\":\"warn\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"${raw[$k]}\"}"
done

sleep 3

for k in "${!raw[@]}"; do
  assert_ge "$(vl_count "service:$TAG AND host:c-$k AND _msg:\"${marker[$k]}\"")" "1" "C $k marker present"
  assert_eq "$(vl_count "service:$TAG AND host:c-$k AND _msg:\"${leak[$k]}\"")" "0" "C $k raw NOT leaked"
done

echo "=== C PASS ==="
