#!/bin/sh
# Vector exec source probe — emit 1 JSON line/lần chạy về size webui.db.
# Chạy bởi vector container (alpine + busybox). KHÔNG dùng bashism.
# Alpine `stat -c` không có → dùng `wc -c` cho size, `date -r` cho mtime.
set -eu

f=/monitor/openwebui/webui.db

if [ -f "$f" ]; then
  size=$(wc -c < "$f" | tr -d ' ')
  mtime=$(date -r "$f" +%s 2>/dev/null || echo 0)
else
  size=0
  mtime=0
fi

gb=$(awk -v s="$size" 'BEGIN{printf "%.3f", s/1073741824}')
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

printf '{"_time":"%s","_msg":"webui_db_size","service":"openwebui-db-monitor","host":"logserver","size_bytes":%s,"size_gb":%s,"mtime_epoch":%s}\n' \
  "$ts" "$size" "$gb" "$mtime"
