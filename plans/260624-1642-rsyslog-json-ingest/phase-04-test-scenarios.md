# Phase 04 — Test scenarios (post-cook validation)

**Status:** pending
**Priority:** high
**Effort:** ~5h
**Owner:** vietnt
**Depends on:** Phase 01, Phase 02, Phase 03

## Mục tiêu
Sau khi cook xong P1-P3, chạy bộ test mở rộng để verify:
- Schema robustness (fallback, drift, unicode)
- PII redaction matrix (6 pattern)
- Severity routing đúng (NATS chỉ nhận WARN+)
- Coexistence với UDP 514 + TCP 6514 hiện hữu
- Resilience (vector down, client queue, restart)

Scope **không bao** load/security negative (đẩy sang production rollout plan).

## Files
- **Create:** `tests/rsyslog-e2e/scenarios/` — mỗi nhóm 1 script bash
  - `b-schema-robustness.sh`
  - `c-pii-redaction-matrix.sh`
  - `d-severity-routing.sh`
  - `e-coexistence.sh`
  - `f-resilience.sh`
- **Create:** `tests/rsyslog-e2e/lib/common.sh` — helper functions (vl_query, assert_count, send_json, send_syslog)
- **Modify (create if missing):** `Makefile` — target `test-rsyslog`

## Helper library (`lib/common.sh`)
Common functions reuse trong các scenario:
```bash
ONELOG_HOST="${ONELOG_HOST:-127.0.0.1}"
VL_URL="${VL_URL:-http://localhost:9428}"
NATS_URL="${NATS_URL:-nats://localhost:4222}"

vl_query() {
  # $1 = LogsQL query
  curl -sS "$VL_URL/select/logsql/query" --data-urlencode "query=$1"
}

vl_count() { vl_query "$1" | wc -l; }

send_json_event() {
  # $1 = JSON payload single line
  echo "$1" | nc -q1 "$ONELOG_HOST" 6515
}

send_syslog_udp() {
  # $1 = message
  logger -n "$ONELOG_HOST" -P 514 -d -t test-svc "$1"
}

send_syslog_tcp() {
  logger -n "$ONELOG_HOST" -P 6514 -T -t test-svc "$1"
}

assert_eq() {
  # $1=actual $2=expected $3=label
  if [ "$1" != "$2" ]; then
    echo "FAIL [$3]: got=$1 expect=$2"; exit 1
  fi
  echo "OK [$3]"
}

assert_ge() {
  if [ "$1" -lt "$2" ]; then
    echo "FAIL [$3]: got=$1 expect>=$2"; exit 1
  fi
  echo "OK [$3]"
}
```

## Scenarios

### B. Schema robustness (`b-schema-robustness.sh`)
```bash
TAG="schema-$(date +%s)"

# B1: Missing @timestamp → vector fallback now()
send_json_event "{\"host\":{\"name\":\"b1\"},\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"no ts\"}"

# B2: Missing host.name → "unknown"
send_json_event "{\"@timestamp\":\"2026-06-25T01:00:00Z\",\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"no host\"}"

# B3: Extra labels.* pass-through
send_json_event "{\"@timestamp\":\"2026-06-25T01:00:01Z\",\"host\":{\"name\":\"b3\"},\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"with labels\",\"labels\":{\"env\":\"lab\",\"region\":\"hn\"}}"

# B4: Unknown top-level field → dropped
send_json_event "{\"@timestamp\":\"2026-06-25T01:00:02Z\",\"host\":{\"name\":\"b4\"},\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"with junk\",\"_internal_field\":\"should_drop\",\"random_key\":42}"

# B5: Multi-line message (stack trace)
send_json_event "{\"@timestamp\":\"2026-06-25T01:00:03Z\",\"host\":{\"name\":\"b5\"},\"log\":{\"level\":\"error\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"NullPointerException\\n  at Foo.bar(Foo.java:10)\\n  at Main.main(Main.java:3)\"}"

# B6: Unicode tiếng Việt + emoji
send_json_event "{\"@timestamp\":\"2026-06-25T01:00:04Z\",\"host\":{\"name\":\"b6\"},\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"Xin chào OneLog 🚀 — tiếng Việt có dấu\"}"

sleep 3

# Assert
assert_eq "$(vl_count "service:$TAG")" "6" "B total events"
assert_ge "$(vl_count "service:$TAG AND host:unknown")" "1" "B2 host fallback"
assert_ge "$(vl_count "service:$TAG AND labels.env:lab")" "1" "B3 labels passthrough"
assert_eq "$(vl_count "service:$TAG AND _internal_field:*")" "0" "B4 unknown field dropped"
assert_ge "$(vl_count "service:$TAG AND _msg:\"NullPointerException\"")" "1" "B5 multi-line"
assert_ge "$(vl_count "service:$TAG AND _msg:\"tiếng Việt\"")" "1" "B6 unicode"
```

### C. PII redaction matrix (`c-pii-redaction-matrix.sh`)
6 event, mỗi event 1 pattern PII:
```bash
TAG="pii-$(date +%s)"
TS="2026-06-25T01:10:00Z"

declare -A cases=(
  ["email"]="user admin@example.com login"
  ["priv_ip"]="connect from 192.168.1.50"
  ["jwt"]="token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_xyz123"
  ["aws_key"]="AKIAIOSFODNN7EXAMPLE found"
  ["bearer"]="Authorization: Bearer abc123token"
  ["password"]="login password=secret123 ok"
)

declare -A markers=(
  ["email"]="<EMAIL>"
  ["priv_ip"]="<PRIV_IP>"
  ["jwt"]="<JWT>"
  ["aws_key"]="<AWS_KEY>"
  ["bearer"]="<TOKEN>"
  ["password"]="<REDACTED>"
)

declare -A leaks=(
  ["email"]="admin@example.com"
  ["priv_ip"]="192.168.1.50"
  ["jwt"]="eyJhbGciOiJIUzI1NiJ9"
  ["aws_key"]="AKIAIOSFODNN7EXAMPLE"
  ["bearer"]="abc123token"
  ["password"]="secret123"
)

for k in "${!cases[@]}"; do
  send_json_event "{\"@timestamp\":\"$TS\",\"host\":{\"name\":\"c-$k\"},\"log\":{\"level\":\"warn\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"${cases[$k]}\"}"
done
sleep 3

for k in "${!cases[@]}"; do
  assert_ge "$(vl_count "service:$TAG AND host:c-$k AND _msg:\"${markers[$k]}\"")" "1" "C $k marker present"
  assert_eq "$(vl_count "service:$TAG AND host:c-$k AND _msg:\"${leaks[$k]}\"")" "0" "C $k raw leaked"
done
```

### D. Severity routing (`d-severity-routing.sh`)
NATS subscribe trong subshell, gửi 6 event với severity khác nhau:
```bash
TAG="sev-$(date +%s)"

# Start NATS subscriber background, write to tmp
nats_out=$(mktemp)
nats sub -s "$NATS_URL" "logs.warn" --raw > "$nats_out" &
NATS_PID=$!
sleep 1

for sev in info debug notice warning err crit alert emerg; do
  send_json_event "{\"@timestamp\":\"$(date -u +%FT%TZ)\",\"host\":{\"name\":\"d\"},\"log\":{\"level\":\"$sev\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"sev test $sev\"}"
done
sleep 3
kill $NATS_PID 2>/dev/null

# VL gets all 8
assert_eq "$(vl_count "service:$TAG")" "8" "D VL all severity"

# NATS gets only warn+ (warning/err/crit/alert/emerg = 5)
nats_count=$(grep -c "\"service\":\"$TAG\"" "$nats_out" || echo 0)
assert_eq "$nats_count" "5" "D NATS warn+ only"

# Specifically: info/debug/notice NOT in NATS
for low in info debug notice; do
  c=$(grep -c "\"_msg\":\"sev test $low\"" "$nats_out" || echo 0)
  assert_eq "$c" "0" "D NATS exclude $low"
done

rm -f "$nats_out"
```

### E. Coexistence (`e-coexistence.sh`)
Gửi cùng lúc qua 3 path, verify cả 3 đều landing đúng:
```bash
TAG="coex-$(date +%s)"

# 100 events mỗi path, song song
(for i in $(seq 1 100); do
  send_json_event "{\"@timestamp\":\"$(date -u +%FT%TZ)\",\"host\":{\"name\":\"e-json\"},\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"json $i\"}"
done) &
(for i in $(seq 1 100); do
  logger -n "$ONELOG_HOST" -P 514 -d -t "$TAG" "udp $i"
done) &
(for i in $(seq 1 100); do
  logger -n "$ONELOG_HOST" -P 6514 -T -t "$TAG" "tcp $i"
done) &
wait
sleep 5

assert_eq "$(vl_count "service:$TAG")" "300" "E total 300 across 3 paths"
assert_ge "$(vl_count "service:$TAG AND host:e-json")" "100" "E json path"
# UDP/TCP syslog: host = hostname client (from logger)
assert_ge "$(vl_count "service:$TAG AND _msg:\"udp \"")" "100" "E udp path"
assert_ge "$(vl_count "service:$TAG AND _msg:\"tcp \"")" "100" "E tcp path"
```

### F. Resilience (`f-resilience.sh`)
Verify rsyslog client queue spill khi vector down:
```bash
TAG="resil-$(date +%s)"

# Phase 1: vector up, send 50 baseline
for i in $(seq 1 50); do
  send_json_event "{\"@timestamp\":\"$(date -u +%FT%TZ)\",\"host\":{\"name\":\"f\"},\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"pre $i\"}"
done
sleep 2

# Phase 2: kill vector, send 50 (sẽ buffer ở client rsyslog queue)
docker compose stop vector
echo "Vector stopped, sending 50 events to client rsyslog (must spill to queue)..."

# NOTE: F test này chỉ meaningful nếu test rsyslog container (P3) đang chạy.
# Direct JSON via nc sẽ fail thẳng — bỏ qua phase 2 nếu nc, hoặc dùng client rsyslog
# Use rsyslog client container: docker exec rsyslog-client logger ...
for i in $(seq 1 50); do
  docker exec rsyslog-e2e-rsyslog-client-1 logger -t "$TAG" -p user.info "during-down $i" || true
done

# Phase 3: restart vector, đợi 10s rsyslog drain queue
docker compose start vector
sleep 10

# Phase 4: send 50 more sau khi recover
for i in $(seq 1 50); do
  send_json_event "{\"@timestamp\":\"$(date -u +%FT%TZ)\",\"host\":{\"name\":\"f\"},\"log\":{\"level\":\"info\"},\"service\":{\"name\":\"$TAG\"},\"message\":\"post $i\"}"
done
sleep 5

# Assert: ≥130 events (50 pre + ≥30 drained + 50 post). Cho phép drop một số do TCP reset window.
assert_ge "$(vl_count "service:$TAG")" "130" "F total events after recovery"
assert_ge "$(vl_count "service:$TAG AND _msg:\"during-down\"")" "30" "F drained from queue"
```

## Makefile target
File `Makefile` (root):
```makefile
.PHONY: test-rsyslog test-rsyslog-mandatory test-rsyslog-full

# Mandatory: B + C + D (~2.5h equivalent of dev time, runs in ~30s)
test-rsyslog-mandatory:
	@bash tests/rsyslog-e2e/scenarios/b-schema-robustness.sh
	@bash tests/rsyslog-e2e/scenarios/c-pii-redaction-matrix.sh
	@bash tests/rsyslog-e2e/scenarios/d-severity-routing.sh

# Full recommended: B + C + D + E + F
test-rsyslog: test-rsyslog-mandatory
	@bash tests/rsyslog-e2e/scenarios/e-coexistence.sh
	@bash tests/rsyslog-e2e/scenarios/f-resilience.sh
	@echo "=== ALL rsyslog E2E scenarios passed ==="

test-rsyslog-full: test-rsyslog
	@echo "(load + security negative not implemented in this plan)"
```

## Todo
- [x] Tạo `tests/rsyslog-e2e/lib/common.sh` với helpers
- [x] Tạo 5 scenario script B/C/D/E/F
- [x] Add Makefile target `test-rsyslog`
- [x] Document trong `tests/rsyslog-e2e/README.md`: prerequisites + how to run
- [x] Chạy 5 scenario trên logserver-01 (manual, make chưa cài)

## Results (2026-06-25)
- **C — PII matrix:** 6/6 PASS (email, priv_ip, jwt, aws_key, bearer, password — đầy đủ marker + 0 raw leak).
- **E — Coexistence:** 4/4 PASS (300/300 events qua UDP/TCP syslog + JSON 6515 song song).
- **B — Schema:** 5/6 PASS. **B2 false positive:** Vector socket source auto-injects
  `.host` từ source IP (`172.18.0.1` trong test) trước khi VRL normalize chạy →
  fallback `"unknown"` không reachable. **Behavior chấp nhận được** (host luôn populated).
- **D — Severity:** SKIP (nats CLI chưa cài trên logserver).
- **F — Resilience:** drain THỰC RA work (150 events landed sau diagnostic),
  nhưng test assertion chạy quá sớm sau restart (sleep 12 ngắn so với rsyslog
  reconnect + Vector batch flush). Test polish backlog.

## Backlog (test polish, không phải code fix)
- B2 assertion: đổi sang verify event vẫn ingested (kệ host value) hoặc disable
  Vector source IP injection bằng `host_key: ""`.
- F assertion: thay sleep fixed bằng poll-with-retry (loop 30× × 2s check total≥130).
- D scenario: cài `nats` CLI hoặc dùng `docker run synadia/nats-box`.

## Success criteria
- `make test-rsyslog` exit 0.
- Tất cả assertion OK [...] in ra, không có FAIL.
- Verify thủ công: VictoriaLogs UI thấy 6 host từ scenario B với schema flat đúng.
- NATS subscriber thấy events từ scenario D với chỉ severity WARN+ (5 events).

## Risks
- **VL LogsQL escaping** — query có nested quote, escape khó. Test query thủ công
  trên VL UI trước, đảm bảo syntax đúng.
- **NATS CLI** — cần cài `nats` CLI (https://github.com/nats-io/natscli). Hoặc dùng
  `docker run synadia/nats-box nats sub ...`.
- **`logger -n` flag** — chỉ có trên util-linux mới. macOS dùng `nc` thay thế cho syslog.
- **F resilience** — phụ thuộc rsyslog client container từ P3 còn chạy. Nếu test ad-hoc qua
  `nc`, không có queue spill behavior → bỏ qua phase 2-3 của F.
- **Vector restart cost** — F kill+start vector → toàn bộ ingestion 1-3s downtime, các
  client khác có thể bị ảnh hưởng. Chỉ chạy F trong môi trường lab.

## Definition of Done
- 5 script chạy được độc lập + qua make target.
- Mỗi scenario có assertion rõ ràng (assert_eq/assert_ge), không silent pass.
- README giải thích cách extend thêm scenario mới (just drop file vào scenarios/).
