#!/usr/bin/env bash
# Daily snapshot of ragstack data: VictoriaLogs + Qdrant + Postgres + secrets.
# Output is age-encrypted (asymmetric) so leaking S3 creds does NOT expose data.
# Usage:  bash snapshot-daily.sh [BACKUP_DIR]
#   BACKUP_DIR default: /opt/onelog/backup
# Cron:   0 2 * * * /opt/onelog/infra/scripts/snapshot-daily.sh >> /var/log/ragstack-snapshot.log 2>&1
# Retention: keep last 3 days locally (S3 has its own lifecycle).
# Prereq: age binary + infra/backup/backup-age.pub committed. See infra/backup/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${INFRA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BACKUP_DIR="${1:-${BACKUP_DIR:-$INFRA_DIR/../backup}}"
DATE="$(date +%Y%m%d-%H%M)"
STAGE="$(mktemp -d -t ragsnap.XXXXXX)"
KEEP_DAYS="${KEEP_DAYS:-3}"

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"

# Load env (POSTGRES_USER, QDRANT_API_KEY)
if [[ -f "$INFRA_DIR/.env" ]]; then
  set -a; . "$INFRA_DIR/.env"; set +a
fi

echo "[snapshot] $(date -Is) start → $BACKUP_DIR"

# --- 1. Postgres logical dump — only when container is running ---
# Postgres is opt-in (profile: kb). Skip cleanly on stacks that don't run it.
echo "[1/5] pg_dump"
if docker inspect -f '{{.State.Running}}' ragstack-postgres 2>/dev/null | grep -q true; then
  docker exec ragstack-postgres sh -c \
    "pg_dump -U '${POSTGRES_USER:-rag}' -d rag -f /tmp/postgres-rag.sql"
  docker cp ragstack-postgres:/tmp/postgres-rag.sql "$STAGE/postgres-rag.sql"
  docker exec ragstack-postgres rm -f /tmp/postgres-rag.sql || true
  if [[ ! -s "$STAGE/postgres-rag.sql" ]]; then
    echo "[snapshot] ERROR pg_dump empty" >&2
    exit 2
  fi
else
  echo "  (postgres not running — skipped; enable profile kb to include)"
fi

# --- 2. Qdrant snapshot API ---
# Dùng jq nếu có; fallback sed cho list collection thô. Mỗi collection lưu vào subdir
# riêng để restore phân biệt được tên collection chứa dấu '-'.
echo "[2/5] qdrant snapshots"
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
echo "[3/5] victorialogs data copy"
if [[ -d "$INFRA_DIR/data/victorialogs" ]]; then
  tar --warning=no-file-changed --ignore-failed-read \
    -C "$INFRA_DIR/data" -cf "$STAGE/victorialogs.tar" victorialogs \
    || echo "[snapshot] warn: tar reported file changed (acceptable for hot copy)"
fi

# --- 4. Secrets bundle (for portability to another VPS) ---
# Bundle .env + caddy TLS certs + alertmanager config into secrets/ so a fresh
# VPS can restore the archive and boot the stack immediately, without an
# out-of-band copy of secrets. Whole archive is age-encrypted below.
echo "[4/5] secrets bundle"
mkdir -p "$STAGE/secrets"
[[ -f "$INFRA_DIR/.env" ]] && cp -p "$INFRA_DIR/.env" "$STAGE/secrets/env"
for d in caddy/data caddy/config alertmanager mcp-tokens; do
  if [[ -d "$INFRA_DIR/$d" ]]; then
    # Flatten path separator so restore can iterate *.tar without ambiguity.
    tar -C "$INFRA_DIR" -cf "$STAGE/secrets/${d//\//_}.tar" "$d" 2>/dev/null || true
  fi
done

# --- 5. MANIFEST + SHA256SUMS (integrity + provenance) ---
echo "[5/5] manifest"
GIT_COMMIT=$(cd "$INFRA_DIR/.." && git rev-parse HEAD 2>/dev/null || echo unknown)
IMAGE_TAGS=$(cd "$INFRA_DIR" && docker compose config --images 2>/dev/null | sort -u | paste -sd, - || echo unknown)
HAS_SECRETS=$([[ -f "$STAGE/secrets/env" ]] && echo true || echo false)
cat > "$STAGE/MANIFEST.json" <<EOF
{
  "version": 1,
  "created": "$(date -Iseconds)",
  "hostname": "$(hostname)",
  "git_commit": "$GIT_COMMIT",
  "image_tags": "$IMAGE_TAGS",
  "has_secrets": $HAS_SECRETS
}
EOF
# SHA256SUMS lists every blob in the stage dir except itself.
(cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

# --- Pack + age encrypt ---
# Asymmetric encryption: VPS only holds public key; leaking VPS or S3 creds does
# NOT expose historical backups (private key stays on operator laptop).
ARCHIVE="$BACKUP_DIR/onelog-${DATE}.tar.gz.age"
AGE_PUB="${BACKUP_AGE_PUB:-$INFRA_DIR/backup/backup-age.pub}"
if [[ ! -f "$AGE_PUB" ]]; then
  echo "[snapshot] ERROR age public key missing: $AGE_PUB" >&2
  echo "[snapshot] see infra/backup/README.md for setup" >&2
  exit 5
fi
if ! command -v age >/dev/null 2>&1; then
  echo "[snapshot] ERROR age binary missing (apt install age)" >&2
  exit 6
fi
tar -C "$STAGE" -czf - . | age -R "$AGE_PUB" -o "$ARCHIVE"
echo "[snapshot] wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# --- Retention (local) ---
find "$BACKUP_DIR" -maxdepth 1 -name 'onelog-*.tar.gz.age' -mtime "+${KEEP_DAYS}" -print -delete || true

# --- S3 offsite push (optional) ---
# Config via infra/.env:
#   BACKUP_S3_ENABLE=true
#   BACKUP_S3_BUCKET=s3://onelog-backups         # or bucket name only if MinIO
#   BACKUP_S3_PREFIX=daily/                       # optional path prefix
#   BACKUP_S3_ENDPOINT=https://minio.corp:9000    # unset for AWS S3
#   BACKUP_S3_KEEP_DAYS=90                        # remote retention (0 = infinite)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION already in env
#
# Prefer bucket lifecycle rule for retention on real S3 (cheap + reliable).
# The KEEP_DAYS purge below is a fallback for MinIO buckets w/o lifecycle.
if [[ "${BACKUP_S3_ENABLE:-false}" == "true" ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "[snapshot] ERROR BACKUP_S3_ENABLE=true but aws cli missing" >&2
    exit 4
  fi
  : "${BACKUP_S3_BUCKET:?Set BACKUP_S3_BUCKET when BACKUP_S3_ENABLE=true}"

  S3_ENDPOINT_ARG=()
  [[ -n "${BACKUP_S3_ENDPOINT:-}" ]] && S3_ENDPOINT_ARG+=(--endpoint-url "$BACKUP_S3_ENDPOINT")

  # Normalize bucket URI — accept both `mybucket` and `s3://mybucket`.
  BUCKET_URI="$BACKUP_S3_BUCKET"
  [[ "$BUCKET_URI" != s3://* ]] && BUCKET_URI="s3://$BUCKET_URI"
  S3_KEY="${BUCKET_URI%/}/${BACKUP_S3_PREFIX:-}onelog-${DATE}.tar.gz.age"

  echo "[snapshot] s3 upload → $S3_KEY"
  aws "${S3_ENDPOINT_ARG[@]}" s3 cp "$ARCHIVE" "$S3_KEY" \
    --only-show-errors \
    --metadata "hostname=$(hostname),created=$(date -Iseconds)"

  # Best-effort remote retention (skip if 0/unset — assume lifecycle handles).
  KEEP_S3="${BACKUP_S3_KEEP_DAYS:-0}"
  if [[ "$KEEP_S3" -gt 0 ]]; then
    CUTOFF_EPOCH=$(( $(date +%s) - KEEP_S3 * 86400 ))
    aws "${S3_ENDPOINT_ARG[@]}" s3 ls "${BUCKET_URI%/}/${BACKUP_S3_PREFIX:-}" 2>/dev/null \
      | awk '{print $1" "$2" "$NF}' \
      | while read -r d t f; do
          [[ "$f" =~ ^onelog-.*\.tar\.gz\.age$ ]] || continue
          FILE_EPOCH=$(date -d "$d $t" +%s 2>/dev/null || echo 0)
          if [[ "$FILE_EPOCH" -gt 0 && "$FILE_EPOCH" -lt "$CUTOFF_EPOCH" ]]; then
            echo "  purge remote: $f"
            aws "${S3_ENDPOINT_ARG[@]}" s3 rm "${BUCKET_URI%/}/${BACKUP_S3_PREFIX:-}$f" --only-show-errors || true
          fi
        done
  fi
fi

echo "[snapshot] $(date -Is) done"
