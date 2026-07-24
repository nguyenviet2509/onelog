#!/bin/sh
# Probe onemcp-tools instrumentation từ docker logs openwebui, emit JSON summary
# cho window `WINDOW_MIN` phút gần nhất. Output stdout — cron append vào rolling log.
#
# Nguồn: `print("[onemcp-tools] tool=X status=Y took=Zms")` trong onemcp-tools.py
# Usage: WINDOW_MIN=5 sh probe-onemcp-perf.sh
# Cron:  */5 * * * * sh /opt/ragstack/probe-onemcp-perf.sh >> /var/log/onemcp-perf.jsonl
#
# YAGNI: chỉ emit metric bạn thực sự alert. Nếu cần thêm p99/histogram — tự thêm.

set -eu

WINDOW_MIN="${WINDOW_MIN:-5}"
CONTAINER="${CONTAINER:-ragstack-openwebui}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Grep lines: [onemcp-tools] tool=search status=ok took=43ms
LINES="$(docker logs "$CONTAINER" --since "${WINDOW_MIN}m" 2>&1 | grep '\[onemcp-tools\]' || true)"

if [ -z "$LINES" ]; then
  printf '{"ts":"%s","window_min":%d,"count":0,"errors":0,"p50_ms":0,"p95_ms":0,"avg_ms":0}\n' \
    "$TS" "$WINDOW_MIN"
  exit 0
fi

# Awk: parse took=Xms + status → count, error_count, min, max, avg, p50, p95
echo "$LINES" | awk -v ts="$TS" -v win="$WINDOW_MIN" '
BEGIN { count=0; errors=0 }
{
  # extract took=Nms
  match($0, /took=([0-9]+)ms/, m)
  if (m[1] != "") { vals[count++] = m[1] + 0 }
  # extract status=X
  match($0, /status=([a-z0-9_]+)/, s)
  if (s[1] != "" && s[1] != "ok") errors++
}
END {
  if (count == 0) {
    printf "{\"ts\":\"%s\",\"window_min\":%d,\"count\":0,\"errors\":0}\n", ts, win
    exit
  }
  # sort ascending for percentile
  n = asort(vals)
  sum = 0
  for (i = 1; i <= n; i++) sum += vals[i]
  avg = sum / n
  p50 = vals[int((n+1)*0.5)]
  p95 = vals[int((n+1)*0.95)]
  if (p95 == 0 && n > 0) p95 = vals[n]
  printf "{\"ts\":\"%s\",\"window_min\":%d,\"count\":%d,\"errors\":%d,\"p50_ms\":%d,\"p95_ms\":%d,\"avg_ms\":%.0f}\n", \
    ts, win, count, errors, p50, p95, avg
}'
