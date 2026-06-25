#!/usr/bin/env bash
# B. Schema robustness — missing fields, extra labels, unknown drop, multi-line, unicode.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"

TAG="schema-$(date +%s)"
echo "=== B. Schema robustness (TAG=$TAG) ==="

# B1: Missing @timestamp → vector fallback now()
send_json_event "{\"host\":{\"name\":\"b1\"},\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"no ts\"}"

# B2: Missing host.name → "unknown"
send_json_event "{\"@timestamp\":\"$(iso_now)\",\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"no host\"}"

# B3: Extra labels.* pass-through
send_json_event "{\"@timestamp\":\"$(iso_now)\",\"host\":{\"name\":\"b3\"},\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"with labels\",\"labels\":{\"env\":\"lab\",\"region\":\"hn\"}}"

# B4: Unknown top-level field → dropped by whitelist
send_json_event "{\"@timestamp\":\"$(iso_now)\",\"host\":{\"name\":\"b4\"},\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"with junk\",\"_internal_field\":\"should_drop\",\"random_key\":42}"

# B5: Multi-line message (stack trace JSON-escaped)
send_json_event "{\"@timestamp\":\"$(iso_now)\",\"host\":{\"name\":\"b5\"},\"log\":{\"level\":\"error\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"NullPointerException\\n  at Foo.bar(Foo.java:10)\\n  at Main.main(Main.java:3)\"}"

# B6: Unicode tiếng Việt + emoji
send_json_event "{\"@timestamp\":\"$(iso_now)\",\"host\":{\"name\":\"b6\"},\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"Xin chào OneLog 🚀 — tiếng Việt có dấu\"}"

sleep 3

# Assertions
assert_eq "$(vl_count "service:$TAG")" "6" "B total events"
assert_ge "$(vl_count "service:$TAG AND host:unknown")" "1" "B2 host fallback to unknown"
assert_ge "$(vl_count "service:$TAG AND labels.env:lab")" "1" "B3 labels.env pass-through"
assert_eq "$(vl_count "service:$TAG AND _internal_field:*")" "0" "B4 unknown top-level dropped"
assert_ge "$(vl_count "service:$TAG AND _msg:NullPointerException")" "1" "B5 multi-line preserved"
assert_ge "$(vl_count "service:$TAG AND _msg:\"tiếng Việt\"")" "1" "B6 unicode preserved"
echo "=== B PASS ==="
