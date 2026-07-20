#!/usr/bin/env bash
# Restore ragstack data from a snapshot archive produced by snapshot-daily.sh
# Usage: bash restore-snapshot.sh <archive.tar.gz>
# WARNING: stops services + overwrites data dirs. Run only when intentional.

set -euo pipefail

ARCHIVE="${1:?usage: restore-snapshot.sh <archive.tar.gz | s3://bucket/key>  (set FORCE=1 to skip prompt)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${INFRA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STAGE="$(mktemp -d -t ragrestore.XXXXXX)"

# S3 URI shortcut — download to /tmp first, then continue with local path.
# Uses same BACKUP_S3_ENDPOINT env as snapshot-daily.sh.
if [[ "$ARCHIVE" == s3://* ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "[restore] ERROR: aws cli missing for S3 URI" >&2; exit 4
  fi
  # Load env early so endpoint URL resolves.
  [[ -f "$INFRA_DIR/.env" ]] && { set -a; . "$INFRA_DIR/.env"; set +a; }
  S3_ENDPOINT_ARG=()
  [[ -n "${BACKUP_S3_ENDPOINT:-}" ]] && S3_ENDPOINT_ARG+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  LOCAL_COPY="/tmp/$(basename "$ARCHIVE")"
  echo "[restore] fetch $ARCHIVE → $LOCAL_COPY"
  aws "${S3_ENDPOINT_ARG[@]}" s3 cp "$ARCHIVE" "$LOCAL_COPY" --only-show-errors
  ARCHIVE="$LOCAL_COPY"
fi

if [[ "${FORCE:-0}" != "1" ]]; then
  echo "[restore] DESTRUCTIVE: this will overwrite victorialogs / qdrant / postgres data."
  echo "[restore] archive: $ARCHIVE"
  read -r -p "Type 'yes' to continue: " ans
  [[ "$ans" == "yes" ]] || { echo "aborted"; exit 1; }
fi

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

if [[ -f "$INFRA_DIR/.env" ]]; then
  set -a; . "$INFRA_DIR/.env"; set +a
fi

echo "[restore] unpack $ARCHIVE → $STAGE"
tar -C "$STAGE" -xzf "$ARCHIVE"

cd "$INFRA_DIR"

# --- 1. Stop affected services ---
echo "[restore] stop victorialogs, qdrant, postgres"
docker compose stop victorialogs qdrant || true
docker compose --profile kb stop postgres 2>/dev/null || true

# --- 2. VictoriaLogs ---
if [[ -f "$STAGE/victorialogs.tar" ]]; then
  echo "[restore] victorialogs data"
  rm -rf "$INFRA_DIR/data/victorialogs"
  tar -C "$INFRA_DIR/data" -xf "$STAGE/victorialogs.tar"
fi

# --- 3. Qdrant: bring qdrant up first, then upload snapshots ---
if [[ -d "$STAGE/qdrant" ]]; then
  echo "[restore] qdrant (upload snapshots via API)"
  docker compose up -d qdrant
  # wait healthy
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:6333/healthz" >/dev/null 2>&1; then break; fi
    sleep 1
  done

  # Layout: $STAGE/qdrant/<collection>/<snapshot-file>
  for col_dir in "$STAGE/qdrant/"*/; do
    [[ -d "$col_dir" ]] || continue
    col="$(basename "$col_dir")"
    for f in "$col_dir"*; do
      [[ -f "$f" ]] || continue
      echo "  - $col ← $(basename "$f")"
      curl -fsS -X POST -H "api-key: ${QDRANT_API_KEY:-}" \
        -F "snapshot=@${f}" \
        "http://127.0.0.1:6333/collections/${col}/snapshots/upload?priority=snapshot" \
        >/dev/null
    done
  done
fi

# --- 4. Postgres — only when archive has a dump ---
if [[ -f "$STAGE/postgres-rag.sql" ]]; then
  echo "[restore] postgres rag db"
  docker compose --profile kb up -d postgres
  for i in $(seq 1 30); do
    if docker exec ragstack-postgres pg_isready -U "${POSTGRES_USER:-rag}" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  docker exec -i ragstack-postgres psql -U "${POSTGRES_USER:-rag}" -d postgres \
    -c "DROP DATABASE IF EXISTS rag WITH (FORCE); CREATE DATABASE rag OWNER ${POSTGRES_USER:-rag};"
  docker exec -i ragstack-postgres psql -U "${POSTGRES_USER:-rag}" -d rag < "$STAGE/postgres-rag.sql"
fi

# --- 5. Restart everything ---
echo "[restore] docker compose up -d"
docker compose up -d

echo "[restore] done"
