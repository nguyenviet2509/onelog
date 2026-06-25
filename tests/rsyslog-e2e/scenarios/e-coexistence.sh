#!/usr/bin/env bash
# E. Coexistence — gửi đồng thời 3 path (UDP 514, TCP 6514, JSON TCP 6515),
# verify cả 3 đều ingest đúng, không field collision.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"

TAG="coex-$(date +%s)"
echo "=== E. Coexistence (TAG=$TAG) ==="

if ! command -v logger >/dev/null 2>&1; then
  echo "SKIP: logger CLI not available"; exit 0
fi

# 100 events mỗi path, song song
(for i in $(seq 1 100); do
  send_json_event "{\"@timestamp\":\"$(iso_now)\",\"host\":{\"name\":\"e-json\"},\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"json $i\"}"
done) &
(for i in $(seq 1 100); do
  send_syslog_udp "$TAG" "udp $i"
done) &
(for i in $(seq 1 100); do
  send_syslog_tcp "$TAG" "tcp $i"
done) &
wait

sleep 5

assert_eq "$(vl_count "service:$TAG")" "300" "E total 300 events across 3 paths"
assert_ge "$(vl_count "service:$TAG AND host:e-json")" "100" "E json path landed"
assert_ge "$(vl_count "service:$TAG AND _msg:\"udp \"")" "100" "E udp path landed"
assert_ge "$(vl_count "service:$TAG AND _msg:\"tcp \"")" "100" "E tcp path landed"
echo "=== E PASS ==="
