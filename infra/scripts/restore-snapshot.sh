#!/usr/bin/env bash
# Restore ragstack data from a snapshot archive produced by snapshot-daily.sh
# Usage: bash restore-snapshot.sh [--no-secrets] <archive.tar.gz.age | s3://bucket/key>
# Env:   BACKUP_AGE_KEY=/path/to/onelog-backup-master.key   (required for .age input)
#        FORCE=1                                            (skip confirm prompt)
#        RESTORE_SECRETS=0                                  (same as --no-secrets)
# WARNING: stops services + overwrites data dirs + overwrites .env. Run only when intentional.

set -euo pipefail

# CLI flags — must come before the archive path.
RESTORE_SECRETS="${RESTORE_SECRETS:-1}"
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --no-secrets) RESTORE_SECRETS=0; shift ;;
    -h|--help)
      sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

ARCHIVE="${1:?usage: restore-snapshot.sh [--no-secrets] <archive.tar.gz.age | s3://bucket/key>  (set FORCE=1 to skip prompt)}"
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

# --- Age decrypt (if .age extension) ---
# Archives from snapshot-daily.sh are age-encrypted for portability + safety.
if [[ "$ARCHIVE" == *.age ]]; then
  : "${BACKUP_AGE_KEY:?Set BACKUP_AGE_KEY=/path/to/onelog-backup-master.key}"
  if ! command -v age >/dev/null 2>&1; then
    echo "[restore] ERROR age missing (apt install age)" >&2; exit 6
  fi
  DECRYPTED="$STAGE/archive.tar.gz"
  echo "[restore] age decrypt → $DECRYPTED"
  age -d -i "$BACKUP_AGE_KEY" -o "$DECRYPTED" "$ARCHIVE"
  ARCHIVE="$DECRYPTED"
fi

echo "[restore] unpack $ARCHIVE → $STAGE"
tar -C "$STAGE" -xzf "$ARCHIVE"

# --- Integrity check ---
if [[ -f "$STAGE/SHA256SUMS" ]]; then
  echo "[restore] verify SHA256SUMS"
  (cd "$STAGE" && sha256sum -c SHA256SUMS --quiet) || {
    echo "[restore] ERROR checksum mismatch — archive corrupted" >&2; exit 7
  }
fi

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

# --- 5. Secrets restore (opt-out via --no-secrets / RESTORE_SECRETS=0) ---
# Portability: archive carries .env + caddy TLS + alertmanager config so a fresh
# VPS can boot the stack without an out-of-band secret transfer.
if [[ -d "$STAGE/secrets" && "$RESTORE_SECRETS" == "1" ]]; then
  echo "[restore] secrets bundle detected"
  # Backup existing .env so we can roll back if the new one is wrong.
  if [[ -f "$INFRA_DIR/.env" ]]; then
    BACKUP_ENV="$INFRA_DIR/.env.pre-restore-$(date +%Y%m%d-%H%M%S)"
    cp -p "$INFRA_DIR/.env" "$BACKUP_ENV"
    echo "  saved existing .env → $BACKUP_ENV"
  fi
  if [[ -f "$STAGE/secrets/env" ]]; then
    install -m 600 "$STAGE/secrets/env" "$INFRA_DIR/.env"
    echo "  restored .env"
  fi
  for t in "$STAGE"/secrets/*.tar; do
    [[ -f "$t" ]] || continue
    echo "  extract $(basename "$t")"
    tar -C "$INFRA_DIR" -xf "$t"
  done
fi

# --- 6. Restart everything ---
echo "[restore] docker compose up -d"
docker compose up -d

echo "[restore] done"
