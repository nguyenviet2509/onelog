#!/usr/bin/env bash
# Daily snapshot of ragstack data: VictoriaLogs + Qdrant + Postgres
# Usage:  bash snapshot-daily.sh [BACKUP_DIR]
#   BACKUP_DIR default: /opt/onelog/backup
# Cron:   0 2 * * * /opt/onelog/infra/scripts/snapshot-daily.sh >> /var/log/ragstack-snapshot.log 2>&1
# Retention: keep last 7 days.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${INFRA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BACKUP_DIR="${1:-${BACKUP_DIR:-$INFRA_DIR/../backup}}"
DATE="$(date +%Y%m%d-%H%M)"
STAGE="$(mktemp -d -t ragsnap.XXXXXX)"
KEEP_DAYS="${KEEP_DAYS:-7}"

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"

# Load env (POSTGRES_USER, QDRANT_API_KEY)
if [[ -f "$INFRA_DIR/.env" ]]; then
  set -a; . "$INFRA_DIR/.env"; set +a
fi

echo "[snapshot] $(date -Is) start → $BACKUP_DIR"

# --- 1. Postgres logical dump (write inside container, then copy out) ---
# Tránh redirect ngoài ăn lỗi từ docker exec; verify file size > 0 trước khi tiếp tục.
echo "[1/3] pg_dump"
docker exec ragstack-postgres sh -c \
  "pg_dump -U '${POSTGRES_USER:-rag}' -d rag -f /tmp/postgres-rag.sql"
docker cp ragstack-postgres:/tmp/postgres-rag.sql "$STAGE/postgres-rag.sql"
docker exec ragstack-postgres rm -f /tmp/postgres-rag.sql || true
if [[ ! -s "$STAGE/postgres-rag.sql" ]]; then
  echo "[snapshot] ERROR pg_dump empty" >&2
  exit 2
fi

# --- 2. Qdrant snapshot API ---
# Dùng jq nếu có; fallback sed cho list collection thô. Mỗi collection lưu vào subdir
# riêng để restore phân biệt được tên collection chứa dấu '-'.
echo "[2/3] qdrant snapshots"
QDRANT_URL="http://127.0.0.1:6333"
COLS_JSON=$(curl -fsS -H "api-key: ${QDRANT_API_KEY:-}" "$QDRANT_URL/collections" || echo '')
if command -v jq >/dev/null 2>&1; then
  COLLECTIONS=$(printf '%s' "$COLS_JSON" | jq -r '.result.collections[].name' 2>/dev/null || true)
else
  COLLECTIONS=$(printf '%s' "$COLS_JSON" | tr ',' '\n' | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' || true)
fi

if [[ -n "${COLLECTIONS:-}" ]]; then
  mkdir -p "$STAGE/qdrant"
  while IFS= read -r col; do
    [[ -z "$col" ]] && continue
    echo "  - $col"
    SNAP_JSON=$(curl -fsS -X POST -H "api-key: ${QDRANT_API_KEY:-}" \
      "$QDRANT_URL/collections/$col/snapshots")
    if command -v jq >/dev/null 2>&1; then
      SNAP=$(printf '%s' "$SNAP_JSON" | jq -r '.result.name')
    else
      SNAP=$(printf '%s' "$SNAP_JSON" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' | head -1)
    fi
    if [[ -n "${SNAP:-}" && "$SNAP" != "null" ]]; then
      mkdir -p "$STAGE/qdrant/$col"
      curl -fsS -H "api-key: ${QDRANT_API_KEY:-}" \
        "$QDRANT_URL/collections/$col/snapshots/$SNAP" \
        -o "$STAGE/qdrant/$col/$SNAP"
    fi
  done <<< "$COLLECTIONS"
fi

# --- 3. VictoriaLogs data dir (filesystem copy) ---
# Single-node VL không có snapshot API; copy data dir hot (best-effort).
# `--warning=no-file-changed` chấp nhận file mutate giữa lúc tar (log đang ghi).
# Nightly snapshot 02:00 thường low-traffic, sai sót nhỏ chấp nhận được.
# Trade-off: muốn consistency tuyệt đối → stop container vài giây trước khi tar.
echo "[3/3] victorialogs data copy"
if [[ -d "$INFRA_DIR/data/victorialogs" ]]; then
  tar --warning=no-file-changed --ignore-failed-read \
    -C "$INFRA_DIR/data" -cf "$STAGE/victorialogs.tar" victorialogs \
    || echo "[snapshot] warn: tar reported file changed (acceptable for hot copy)"
fi

# --- Pack ---
ARCHIVE="$BACKUP_DIR/onelog-${DATE}.tar.gz"
tar -C "$STAGE" -czf "$ARCHIVE" .
echo "[snapshot] wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# --- Retention ---
find "$BACKUP_DIR" -maxdepth 1 -name 'onelog-*.tar.gz' -mtime "+${KEEP_DAYS}" -print -delete || true

echo "[snapshot] $(date -Is) done"
