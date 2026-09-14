#!/usr/bin/env bash
# pre-migration-019-backup.sh — Backup + verify trước khi apply Migration 019.
#
# Chạy trước migration 019 để đảm bảo có safety net:
#   1. pg_dump toàn bộ rbac schema (custom format)
#   2. SHA256 dump file
#   3. Restore vào tmp DB → smoke query verify
#   4. Drop tmp DB → exit 0 nếu OK
#
# Usage: bash scripts/pre-migration-019-backup.sh
#
# Env vars (fallback defaults matching bootstrap-dev):
#   WRITER_DATABASE_URL — main DB connection string
#   BACKUP_DIR          — output dir (default: ./backups)
#
# Exit codes:
#   0 = backup + verify OK, safe to proceed
#   1 = pg_dump failed
#   2 = restore verify failed
#   3 = missing tools (pg_dump / pg_restore / psql / sha256sum)

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
DATABASE_URL="${WRITER_DATABASE_URL:-postgresql://rbac_writer:rbac_writer_changeme@localhost:5433/central_rbac}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="${BACKUP_DIR}/central_rbac-pre019-${TIMESTAMP}.dump"
SHA256_FILE="${DUMP_FILE}.sha256"
TMP_DB="central_rbac_verify_${TIMESTAMP}"

# ============================================================================
# 1. Verify tools
# ============================================================================
for tool in pg_dump pg_restore psql sha256sum createdb dropdb; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    echo "ERROR: missing tool: $tool" >&2
    exit 3
  fi
done

mkdir -p "$BACKUP_DIR"

# ============================================================================
# 2. pg_dump (custom format, schema rbac only)
# ============================================================================
echo "[1/4] pg_dump → $DUMP_FILE"
if ! pg_dump \
  --format=custom \
  --schema=rbac \
  --no-owner \
  --no-privileges \
  --file="$DUMP_FILE" \
  "$DATABASE_URL"; then
  echo "ERROR: pg_dump failed" >&2
  exit 1
fi

# ============================================================================
# 3. SHA256 checksum
# ============================================================================
echo "[2/4] SHA256 → $SHA256_FILE"
sha256sum "$DUMP_FILE" > "$SHA256_FILE"
DUMP_SIZE="$(du -h "$DUMP_FILE" | cut -f1)"
echo "  Dump size: $DUMP_SIZE"

# ============================================================================
# 4. Restore verify (tmp DB → smoke query → drop)
# ============================================================================
# Extract superuser connection từ DATABASE_URL để createdb/dropdb.
# Format: postgresql://user:pass@host:port/db → strip db name.
BASE_URL="$(echo "$DATABASE_URL" | sed -E 's|/[^/]+$||')"

echo "[3/4] Restore verify → tmp DB: $TMP_DB"
createdb --dbname="$BASE_URL" "$TMP_DB"

# Trap để cleanup tmp DB nếu script fail giữa chừng
trap 'dropdb --dbname="$BASE_URL" --if-exists "$TMP_DB" 2>/dev/null || true' EXIT

# Restore dump
if ! pg_restore \
  --dbname="${BASE_URL}/${TMP_DB}" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "$DUMP_FILE"; then
  echo "ERROR: pg_restore failed" >&2
  exit 2
fi

# Smoke query: verify schema + expected tables
SMOKE_QUERY="
SELECT
  (SELECT COUNT(*) FROM rbac.apps) AS apps_count,
  (SELECT COUNT(*) FROM rbac.roles) AS roles_count,
  (SELECT COUNT(*) FROM rbac.permissions) AS perms_count,
  (SELECT COUNT(*) FROM rbac.schema_migrations) AS migrations_count;
"
echo "[4/4] Smoke query on tmp DB"
if ! psql --dbname="${BASE_URL}/${TMP_DB}" --command="$SMOKE_QUERY" --no-psqlrc --tuples-only; then
  echo "ERROR: smoke query failed on restored DB" >&2
  exit 2
fi

# Cleanup tmp DB (trap sẽ handle nếu miss)
dropdb --dbname="$BASE_URL" "$TMP_DB"
trap - EXIT

# ============================================================================
# Success
# ============================================================================
echo ""
echo "✅ Backup + verify OK"
echo "   Dump:   $DUMP_FILE"
echo "   SHA256: $(cat "$SHA256_FILE")"
echo ""
echo "Safe to proceed với: npm run migrate"
exit 0
