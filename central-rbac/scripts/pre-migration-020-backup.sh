#!/usr/bin/env bash
# pre-migration-020-backup.sh — Backup + verify trước khi apply Migration 020.
#
# Chạy trước migration 020 (app_tokens table):
#   1. pg_dump toàn bộ rbac schema (custom format)
#   2. SHA256 dump file
#   3. Restore vào tmp DB → smoke query verify
#   4. Drop tmp DB → exit 0 nếu OK
#
# Usage: bash scripts/pre-migration-020-backup.sh
#
# Env vars:
#   WRITER_DATABASE_URL — main DB connection string
#   BACKUP_DIR          — output dir (default: ./backups)
#
# Exit codes:
#   0 = backup + verify OK
#   1 = pg_dump failed
#   2 = restore verify failed
#   3 = missing tools

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
DATABASE_URL="${WRITER_DATABASE_URL:-postgresql://rbac_writer:rbac_writer_changeme@localhost:5433/central_rbac}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="${BACKUP_DIR}/central_rbac-pre020-${TIMESTAMP}.dump"
SHA256_FILE="${DUMP_FILE}.sha256"
TMP_DB="central_rbac_verify_${TIMESTAMP}"

for tool in pg_dump pg_restore psql sha256sum createdb dropdb; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    echo "ERROR: missing tool: $tool" >&2
    exit 3
  fi
done

mkdir -p "$BACKUP_DIR"

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

echo "[2/4] SHA256 → $SHA256_FILE"
sha256sum "$DUMP_FILE" > "$SHA256_FILE"
DUMP_SIZE="$(du -h "$DUMP_FILE" | cut -f1)"
echo "  Dump size: $DUMP_SIZE"

BASE_URL="$(echo "$DATABASE_URL" | sed -E 's|/[^/]+$||')"

echo "[3/4] Restore verify → tmp DB: $TMP_DB"
createdb --dbname="$BASE_URL" "$TMP_DB"

trap 'dropdb --dbname="$BASE_URL" --if-exists "$TMP_DB" 2>/dev/null || true' EXIT

if ! pg_restore \
  --dbname="${BASE_URL}/${TMP_DB}" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "$DUMP_FILE"; then
  echo "ERROR: pg_restore failed" >&2
  exit 2
fi

# Smoke query: verify schema state pre-020 (user_grants + apps + roles exist,
# app_tokens should NOT yet exist).
SMOKE_QUERY="
SELECT
  (SELECT COUNT(*) FROM rbac.apps) AS apps_count,
  (SELECT COUNT(*) FROM rbac.roles) AS roles_count,
  (SELECT COUNT(*) FROM rbac.user_grants) AS grants_count,
  (SELECT COUNT(*) FROM rbac.schema_migrations) AS migrations_count,
  (SELECT NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='rbac' AND table_name='app_tokens'
  )) AS app_tokens_absent;
"
echo "[4/4] Smoke query on tmp DB"
if ! psql --dbname="${BASE_URL}/${TMP_DB}" --command="$SMOKE_QUERY" --no-psqlrc --tuples-only; then
  echo "ERROR: smoke query failed on restored DB" >&2
  exit 2
fi

dropdb --dbname="$BASE_URL" "$TMP_DB"
trap - EXIT

echo ""
echo "✅ Backup + verify OK"
echo "   Dump:   $DUMP_FILE"
echo "   SHA256: $(cat "$SHA256_FILE")"
echo ""
echo "Safe to proceed với: npm run migrate"
exit 0
