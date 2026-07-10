#!/bin/sh
# Vector exec source probe — data disk /opt/ragstack/data via bind mount /host/data.
# Runs inside Vector container (alpine + busybox).
# Compose bind: /opt/ragstack/data:/host/data:ro,rslave (rslave để thấy nested mount).
# Output: 1 dòng JSON per run về stdout, Vector parse qua transform logserver_disk_parse.
set -eu

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
target=/host/data

# Guard: mount thật sự visible. Nếu bind + rslave chưa apply đúng, emit error event.
if ! [ -d "$target" ]; then
  printf '{"_time":"%s","_msg":"disk_probe_error","service":"logserver-disk-monitor","source_stream":"vector-exec-probe","host":"logserver","mount":"/opt/ragstack/data","probe_error":"target_not_mounted"}\n' "$ts"
  exit 0
fi

# `df -PB1` = POSIX + block size 1 byte. tail -n +2 skip header.
# tr '\n' ' ' join wrapped line (busybox df wraps khi device name > 20 chars, VD LVM path).
df -PB1 "$target" 2>/dev/null | tail -n +2 | tr '\n' ' ' | awk -v ts="$ts" '
  {
    fs=$1; size=$2; used=$3; avail=$4; used_pct_str=$5;
    # JSON escape backslash + double-quote cho fs field. Mount hard-coded ASCII safe.
    gsub(/\\/, "\\\\", fs);
    gsub(/"/, "\\\"", fs);
    # used_pct format "NN%" → strip %
    sub(/%$/, "", used_pct_str);
    if (size == "" || used_pct_str == "") next;
    printf "{\"_time\":\"%s\",\"_msg\":\"disk_usage\",\"service\":\"logserver-disk-monitor\",\"source_stream\":\"vector-exec-probe\",\"host\":\"logserver\",\"mount\":\"/opt/ragstack/data\",\"fs\":\"%s\",\"size_bytes\":%s,\"used_bytes\":%s,\"avail_bytes\":%s,\"used_pct\":%s}\n", ts, fs, size, used, avail, used_pct_str;
  }
'
