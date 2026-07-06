#!/usr/bin/env bash
# OpenWebUI SQLite maintenance — dồn gọn file, KHÔNG xóa dữ liệu.
#
# Bảo toàn 100% chat + user + config. Sau khi chạy, WebUI vẫn xem đủ lịch sử.
# Chỉ 3 thao tác an toàn:
#   - PRAGMA optimize        : refresh statistics cho query planner (no lock)
#   - PRAGMA wal_checkpoint  : flush WAL vào file chính
#   - PRAGMA integrity_check : verify không corruption
#   - VACUUM                 : rebuild file gọn lại (reclaim freelist)
#
# 2 mode để tránh downtime khi không cần:
#   weekly   → optimize + integrity_check (no downtime, ~1-3s)
#   monthly  → backup + stop + VACUUM + start (downtime 1-5 phút tùy DB size)
#
# Usage:
#   bash openwebui-db-maintenance.sh weekly
#   bash openwebui-db-maintenance.sh monthly [--skip-backup]
#   bash openwebui-db-maintenance.sh check       # dry-run: chỉ report size + freelist
#
# Cron gợi ý (crontab -e):
#   30 4 * * 0   /home/vietnt/onelog/infra/scripts/openwebui-db-maintenance.sh weekly  >> /var/log/openwebui-db.log 2>&1
#   0  4 1 * *   /home/vietnt/onelog/infra/scripts/openwebui-db-maintenance.sh monthly >> /var/log/openwebui-db.log 2>&1
#
# Log format = JSON per event, vector đã có source tail file này (weekly) hoặc
# grep từ docker logs (nếu run trong container). Chuyển thẳng vào VictoriaLogs
# với service=openwebui-db-monitor để dùng chung dashboard/alert.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${INFRA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DB_HOST_PATH="${DB_HOST_PATH:-$INFRA_DIR/data/openwebui/webui.db}"
DB_CTR_PATH="/app/backend/data/webui.db"
COMPOSE="docker compose -f $INFRA_DIR/docker-compose.yml"

MODE="${1:-check}"
SKIP_BACKUP=0
[[ "${2:-}" == "--skip-backup" ]] && SKIP_BACKUP=1

# Error trap — nếu script chết vì set -e, in dòng lỗi ra stderr thay vì im lặng.
trap 'rc=$?; echo "{\"_msg\":\"script_error\",\"line\":$LINENO,\"exit_code\":$rc,\"cmd\":\"${BASH_COMMAND//\"/\\\"}\"}" >&2; exit $rc' ERR

# ─── helpers ─────────────────────────────────────────────────────────────
log_json() {
  # $1 = event name, rest = key=value pairs
  local event="$1"; shift
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local extras=""
  for kv in "$@"; do
    local k="${kv%%=*}" v="${kv#*=}"
    # numeric passthrough — no quote nếu là số nguyên/float
    if [[ "$v" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
      extras+=",\"$k\":$v"
    else
      extras+=",\"$k\":\"${v//\"/\\\"}\""
    fi
  done
  printf '{"_time":"%s","_msg":"%s","service":"openwebui-db-monitor","host":"logserver","mode":"%s"%s}\n' \
    "$ts" "$event" "$MODE" "$extras"
}

file_size() {
  stat -c%s "$DB_HOST_PATH" 2>/dev/null || echo 0
}

# Chạy SQL trong container openwebui đang up qua Python stdlib sqlite3.
# LÝ DO không dùng binary `sqlite3`: image openwebui Python-based không cài
# CLI sqlite3. Module `sqlite3` thì luôn có (Python stdlib) → portable hơn.
# Trả về scalar đầu tiên của query đầu tiên (giữ signature giống sqlite3 CLI).
sqlite_query_live() {
  local sql="$1"
  $COMPOSE exec -T openwebui python3 - "$DB_CTR_PATH" "$sql" <<'PY'
import sqlite3, sys
db, sql = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db, timeout=30)
try:
    row = con.execute(sql).fetchone()
    print(row[0] if row else "")
finally:
    con.close()
PY
}

# Exec pragma/statement, không cần return value. Dùng cho PRAGMA optimize, VACUUM.
sqlite_exec_live() {
  local sql="$1"
  $COMPOSE exec -T openwebui python3 - "$DB_CTR_PATH" "$sql" <<'PY'
import sqlite3, sys
db, sql = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db, timeout=60, isolation_level=None)
try:
    for stmt in [s.strip() for s in sql.split(";") if s.strip()]:
        con.execute(stmt)
finally:
    con.close()
PY
}

# Chạy SQL qua container Python tạm khi openwebui đã stop (VACUUM cần
# exclusive lock nên phải stop main container trước).
# Dùng image python:3-alpine (nhẹ ~50MB, đã có sqlite3 stdlib).
sqlite_exec_offline() {
  local sql="$1"
  docker run --rm -i \
    -v "$INFRA_DIR/data/openwebui:/data" \
    python:3-alpine \
    python3 - "$sql" <<'PY'
import sqlite3, sys
sql = sys.argv[1]
con = sqlite3.connect("/data/webui.db", timeout=300, isolation_level=None)
try:
    for stmt in [s.strip() for s in sql.split(";") if s.strip()]:
        print(f">>> {stmt[:80]}", file=sys.stderr)
        cur = con.execute(stmt)
        row = cur.fetchone()
        if row is not None:
            print(f"<<< {row}", file=sys.stderr)
finally:
    con.close()
PY
}

require_db_exists() {
  if [[ ! -f "$DB_HOST_PATH" ]]; then
    log_json "db_missing" path="$DB_HOST_PATH" >&2
    exit 1
  fi
}

# ─── check mode ──────────────────────────────────────────────────────────
# Dry-run: report metrics, không sửa gì. An toàn chạy bất cứ lúc nào.
do_check() {
  require_db_exists
  local size_before; size_before=$(file_size)
  # Đọc freelist qua openwebui live (read-only query, không lock).
  local page_count page_size freelist
  page_count=$(sqlite_query_live "PRAGMA page_count" | tr -d '[:space:]')
  page_size=$(sqlite_query_live  "PRAGMA page_size"  | tr -d '[:space:]')
  freelist=$(sqlite_query_live   "PRAGMA freelist_count" | tr -d '[:space:]')

  local dead_bytes=$((freelist * page_size))
  local ratio="0"
  if [[ "$size_before" -gt 0 ]]; then
    ratio=$(awk -v d=$dead_bytes -v s=$size_before 'BEGIN{printf "%.4f", d/s}')
  fi

  log_json "db_check" \
    size_bytes=$size_before \
    page_count=$page_count \
    page_size=$page_size \
    freelist_pages=$freelist \
    dead_bytes=$dead_bytes \
    freelist_ratio=$ratio

  # Recommendation
  if awk -v r=$ratio 'BEGIN{exit !(r>0.3)}'; then
    log_json "recommend" action=vacuum reason="freelist>30%"
  elif [[ "$size_before" -gt 524288000 ]]; then
    log_json "recommend" action=vacuum reason="size>500MB"
  else
    log_json "recommend" action=none reason="healthy"
  fi
}

# ─── weekly mode ─────────────────────────────────────────────────────────
# No downtime. Refresh statistics + verify integrity + flush WAL.
# KHÔNG xóa data, KHÔNG rebuild file. An toàn với container đang chạy.
do_weekly() {
  require_db_exists
  local t0=$(date +%s)
  log_json "weekly_start"

  # PRAGMA optimize = auto ANALYZE khi cần. Rất nhanh (< 1s cho DB < 1GB).
  sqlite_exec_live "PRAGMA optimize" >/dev/null

  # Flush WAL vào main file. TRUNCATE mode = reset WAL về 0 bytes sau flush.
  # KHÔNG mất data — chỉ move từ WAL sang main. OpenWebUI vẫn append tiếp OK.
  local wal_result
  wal_result=$(sqlite_query_live "PRAGMA wal_checkpoint(TRUNCATE)" || echo "skip")

  # Integrity check — verify file không bị corrupt sau WAL flush.
  local integrity
  integrity=$(sqlite_query_live "PRAGMA integrity_check" | tr -d '[:space:]')

  local t1=$(date +%s)
  local size_now; size_now=$(file_size)

  if [[ "$integrity" != "ok" ]]; then
    log_json "weekly_fail" integrity="$integrity" duration_s=$((t1-t0)) size_bytes=$size_now >&2
    exit 2
  fi

  log_json "weekly_done" \
    integrity="$integrity" \
    wal_result="${wal_result:-none}" \
    duration_s=$((t1-t0)) \
    size_bytes=$size_now
}

# ─── monthly mode ────────────────────────────────────────────────────────
# Có downtime (1-5 phút). VACUUM rebuild file toàn bộ để reclaim space.
# Trước khi VACUUM: chạy backup script để có rollback point.
# KHÔNG xóa data — VACUUM chỉ dồn lại theo đúng thứ tự.
do_monthly() {
  require_db_exists
  local t0=$(date +%s)
  local size_before; size_before=$(file_size)
  log_json "monthly_start" size_before=$size_before

  # 1. Backup TRƯỚC vacuum (skip được nếu chạy manual sau khi vừa backup)
  if [[ $SKIP_BACKUP -eq 0 ]]; then
    log_json "backup_start"
    if bash "$SCRIPT_DIR/backup-openwebui.sh" >/dev/null 2>&1; then
      log_json "backup_ok"
    else
      log_json "backup_fail" >&2
      log_json "monthly_abort" reason="backup failed — không dám VACUUM khi chưa có rollback" >&2
      exit 3
    fi
  else
    log_json "backup_skip" reason="--skip-backup flag"
  fi

  # 2. Stop container để giải phóng exclusive lock.
  log_json "stop_openwebui"
  $COMPOSE --profile chat stop openwebui >/dev/null

  # 3. VACUUM offline. Chạy qua container tạm để không phụ thuộc sqlite3 host.
  # Nếu image keinos/sqlite3 không có sẵn, docker sẽ pull tự động lần đầu.
  local vac_start=$(date +%s)
  local vac_status=0
  if sqlite_exec_offline "PRAGMA integrity_check; VACUUM; PRAGMA integrity_check" > /tmp/vacuum-out.txt 2>&1; then
    log_json "vacuum_ok" duration_s=$(($(date +%s) - vac_start))
  else
    vac_status=$?
    log_json "vacuum_fail" duration_s=$(($(date +%s) - vac_start)) exit_code=$vac_status >&2
    log_json "vacuum_stderr" text="$(tr '\n' ' ' </tmp/vacuum-out.txt)" >&2
    # KHÔNG rollback tự động — start lại container, data cũ vẫn nguyên.
    # Ops đọc log rồi quyết định restore từ backup nếu cần.
  fi

  # 4. Start lại openwebui.
  log_json "start_openwebui"
  $COMPOSE --profile chat up -d openwebui >/dev/null

  # 5. Report kết quả.
  local size_after; size_after=$(file_size)
  local reclaimed=$((size_before - size_after))
  local pct="0"
  if [[ "$size_before" -gt 0 ]]; then
    pct=$(awk -v r=$reclaimed -v s=$size_before 'BEGIN{printf "%.2f", 100*r/s}')
  fi
  local t1=$(date +%s)

  log_json "monthly_done" \
    size_before=$size_before \
    size_after=$size_after \
    reclaimed_bytes=$reclaimed \
    reclaimed_pct=$pct \
    duration_s=$((t1-t0)) \
    vacuum_exit=$vac_status

  # Verify sau khi start: DB reachable qua container live?
  sleep 3
  if sqlite_query_live "SELECT COUNT(*) FROM sqlite_master WHERE type='table'" >/dev/null 2>&1; then
    log_json "post_verify_ok"
  else
    log_json "post_verify_fail" reason="openwebui không đọc được webui.db sau restart" >&2
    exit 4
  fi
}

# ─── dispatcher ──────────────────────────────────────────────────────────
case "$MODE" in
  check)    do_check ;;
  weekly)   do_weekly ;;
  monthly)  do_monthly ;;
  *)
    echo "usage: $0 {check|weekly|monthly} [--skip-backup]" >&2
    exit 1
    ;;
esac
