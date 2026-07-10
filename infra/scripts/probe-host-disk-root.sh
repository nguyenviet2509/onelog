#!/bin/sh
# Host-side probe — root partition `/`. Chạy từ cron mỗi 5 phút.
# Curl JSON event trực tiếp vào VictoriaLogs /insert/jsonline endpoint.
# Không cần Vector container, không cần bind mount rootfs (bảo mật).
#
# Deploy:
#   sudo cp probe-host-disk-root.sh /usr/local/bin/onelog-probe-host-disk.sh
#   sudo chmod +x /usr/local/bin/onelog-probe-host-disk.sh
#   Add crontab: */5 * * * * VL_ENDPOINT=http://127.0.0.1:9428/insert/jsonline \
#                   /usr/local/bin/onelog-probe-host-disk.sh \
#                   >> /var/log/onelog-host-probe.log 2>&1
set -eu

VL_ENDPOINT="${VL_ENDPOINT:-http://127.0.0.1:9428/insert/jsonline?_stream_fields=service,host}"
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Build JSON payload từ df output, pipe vào curl POST.
df -PB1 / 2>/dev/null | tail -n +2 | tr '\n' ' ' | awk -v ts="$ts" '
  {
    fs=$1; size=$2; used=$3; avail=$4; used_pct_str=$5;
    gsub(/\\/, "\\\\", fs); gsub(/"/, "\\\"", fs);
    sub(/%$/, "", used_pct_str);
    if (size == "" || used_pct_str == "") exit 1;
    printf "{\"_time\":\"%s\",\"_msg\":\"disk_usage\",\"service\":\"host-disk-monitor\",\"source_stream\":\"host-cron-probe\",\"host\":\"logserver\",\"mount\":\"/\",\"fs\":\"%s\",\"size_bytes\":%s,\"used_bytes\":%s,\"avail_bytes\":%s,\"used_pct\":%s}\n", ts, fs, size, used, avail, used_pct_str;
  }
' | curl -fsS -X POST -H "Content-Type: application/stream+json" --data-binary @- "$VL_ENDPOINT"
