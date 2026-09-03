#!/usr/bin/env bash
# Daily snapshot of ALL OneLog state — encrypted with age, pushed to S3.
# Covers: Qdrant, VictoriaLogs, VictoriaMetrics, OpenWebUI (SQLite + files),
#         Grafana (SQLite + provisioning), NATS JetStream, alertmanager, audit
#         logs, indexer state, secrets (.env + Caddy TLS + mcp-tokens).
# Excluded: Vector disk buffer (transient checkpoints), Postgres (decommissioned;
#           dormant block kept in case it's ever resurrected).
# Output is age-encrypted (asymmetric) so leaking S3 creds does NOT expose data.
# Usage:  bash snapshot-daily.sh [BACKUP_DIR]
#   BACKUP_DIR default: /opt/onelog/backup
# Cron:   0 2 * * * /opt/onelog/infra/scripts/snapshot-daily.sh >> /var/log/onelog-snapshot.log 2>&1
# Retention:
#   S3 → BACKUP_S3_KEEP_DAYS in infra/.env (recommended: 5).
#   Local → deleted immediately after successful S3 upload; failed uploads
#           linger up to KEEP_DAYS (default 2) as a stranded-file safety net.
# Prereq: age binary + infra/backup/backup-age.pub committed. See infra/backup/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${INFRA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BACKUP_DIR="${1:-${BACKUP_DIR:-$INFRA_DIR/../backup}}"
DATE="$(date +%Y%m%d-%H%M)"
STAGE="$(mktemp -d -t ragsnap.XXXXXX)"
# Local disk is a staging area only when S3 is enabled — successful upload
# deletes the archive immediately. Failed uploads linger for KEEP_DAYS so a
# manual retry (or the next cron run) can retransmit before eviction.
KEEP_DAYS="${KEEP_DAYS:-2}"

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"

# Load env (POSTGRES_USER, QDRANT_API_KEY)
if [[ -f "$INFRA_DIR/.env" ]]; then
  set -a; . "$INFRA_DIR/.env"; set +a
fi

echo "[snapshot] $(date -Is) start → $BACKUP_DIR"

# Helper: hot-tar a data subdir. Best-effort (accept mutation during read).
# Grafana + OpenWebUI use SQLite WAL; a raw tar snapshot is safe enough for a
# nightly point-in-time backup. For stricter consistency, stop the service.
tar_data_dir() {
  local name="$1"
  local src="$INFRA_DIR/data/$name"
  if [[ ! -d "$src" ]]; then
    echo "  ($name dir missing — skipped)"
    return 0
  fi
  tar --warning=no-file-changed --ignore-failed-read \
    -C "$INFRA_DIR/data" -cf "$STAGE/${name}.tar" "$name" \
    || echo "  warn: tar reported file changed for $name (acceptable for hot copy)"
}

# --- 1. Postgres logical dump — only when container is running ---
# Postgres decommissioned 2026-07-17. Dormant block: skips cleanly on stacks
# without it, activates automatically if profile `kb` ever comes back.
echo "[1/9] pg_dump"
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
echo "[2/9] qdrant snapshots"
QDRANT_URL="http://127.0.0.1:6333"
COLS_JSON=$(curl -fsS -H "api-key: ${QDRANT_API_KEY:-}" "$QDRANT_URL/collections" || echo '')
if command -v jq >/dev/null 2>&1; then
  COLLECTIONS=$(printf '%s' "$COLS_JSON" | jq -r '.result.collections[].name' 2>/dev/null || true)
else
  COLLECTIONS=$(printf '%s' "$COLS_JSON" | tr ',' '\n' | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' || true)
fi

# Track fresh snapshots (col:name pairs) created trong run này. Sau khi archive
# tạo xong (line ~190), snapshots CŨ được prune, chỉ giữ 1 mới nhất per collection.
# Rationale: mỗi run tạo snapshot ~2.4GB × 30d retention = 72GB tích lũy → OOM disk
# (incident 2026-09-03). S3 archive đã bundle snapshot → local Qdrant snapshot cũ
# = redundancy dư thừa. Rolling 1 local đủ cho fast-recovery (<1 min curl restore)
# without cần age key + S3 network như restore từ archive.
QDRANT_FRESH_SNAPS=""

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
      QDRANT_FRESH_SNAPS+="${col}|${SNAP}"$'\n'
    fi
  done <<< "$COLLECTIONS"
fi

# Prune helper: gọi sau khi archive tạo thành công. Rolling replace — giữ snapshot
# mới nhất per collection (thứ vừa bundle vào archive), xóa mọi cái cũ hơn.
qdrant_prune_old_snapshots() {
  [[ -z "$QDRANT_FRESH_SNAPS" ]] && return 0
  echo "[snapshot] qdrant prune old snapshots (keep newest per collection)"
  local col keep_snap all_snaps snap
  while IFS='|' read -r col keep_snap; do
    [[ -z "$col" || -z "$keep_snap" ]] && continue
    if command -v jq >/dev/null 2>&1; then
      all_snaps=$(curl -fsS -H "api-key: ${QDRANT_API_KEY:-}" \
        "$QDRANT_URL/collections/$col/snapshots" \
        | jq -r '.result[].name' 2>/dev/null || true)
    else
      all_snaps=$(curl -fsS -H "api-key: ${QDRANT_API_KEY:-}" \
        "$QDRANT_URL/collections/$col/snapshots" \
        | tr ',' '\n' | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' || true)
    fi
    while IFS= read -r snap; do
      [[ -z "$snap" || "$snap" == "$keep_snap" ]] && continue
      echo "  del: $col/$snap"
      curl -fsS -X DELETE -H "api-key: ${QDRANT_API_KEY:-}" \
        "$QDRANT_URL/collections/$col/snapshots/$snap" >/dev/null 2>&1 || \
        echo "  warn: delete failed for $col/$snap"
    done <<< "$all_snaps"
  done <<< "$QDRANT_FRESH_SNAPS"
}

# --- 3. VictoriaLogs data dir (filesystem copy) ---
# Single-node VL has no snapshot API; hot copy is best-effort. Nightly 02:00 is
# low-traffic; want strict consistency → stop container before the tar.
echo "[3/9] victorialogs data"
tar_data_dir victorialogs

# --- 4. VictoriaMetrics data dir ---
# VM has /snapshot/create API but it produces an on-disk snapshot dir we'd have
# to tar anyway. Hot tar of the data dir is equivalent for nightly grain and
# keeps this script uniform.
echo "[4/9] victoriametrics data"
tar_data_dir victoriametrics

# --- 5. OpenWebUI (SQLite webui.db + uploaded files + vector store) ---
# Contains user accounts, chat history (may include PII from pasted logs),
# uploaded files, tools cache. Largest single component (~1GB typical).
echo "[5/9] openwebui data"
tar_data_dir openwebui

# --- 6. Grafana (SQLite grafana.db + provisioning artifacts) ---
# Has users/orgs/API keys/alert state that aren't in git provisioning.
echo "[6/9] grafana data"
tar_data_dir grafana

# --- 7. NATS JetStream (message state) ---
echo "[7/9] nats data"
tar_data_dir nats

# --- 8. Small state bundle: alertmanager + audit + indexer ---
# Bundled together because each is < 1MB and restoring is trivially symmetric.
# alertmanager: silences/notifications state; audit: append-only audit trail;
# indexer: drain3 template state (log parsing patterns learned over time).
echo "[8/9] misc state (alertmanager, audit, indexer)"
for d in alertmanager audit indexer; do
  tar_data_dir "$d"
done

# --- 9a. Secrets bundle (for portability to another VPS) ---
# Bundle .env + caddy TLS certs + alertmanager config into secrets/ so a fresh
# VPS can restore the archive and boot the stack immediately, without an
# out-of-band copy of secrets. Whole archive is age-encrypted below.
echo "[9/9] secrets bundle + manifest"
mkdir -p "$STAGE/secrets"
[[ -f "$INFRA_DIR/.env" ]] && cp -p "$INFRA_DIR/.env" "$STAGE/secrets/env"
for d in caddy/data caddy/config alertmanager mcp-tokens; do
  if [[ -d "$INFRA_DIR/$d" ]]; then
    # Flatten path separator so restore can iterate *.tar without ambiguity.
    tar -C "$INFRA_DIR" -cf "$STAGE/secrets/${d//\//_}.tar" "$d" 2>/dev/null || true
  fi
done

# --- 9b. MANIFEST + SHA256SUMS (integrity + provenance) ---
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

# Archive tạo xong → snapshot cũ trong Qdrant an toàn để prune. S3 upload có
# thể fail phía dưới, nhưng archive local đã capture snapshot mới. Fast-recovery
# path (rolling 1 snapshot per collection) preserved regardless of S3 outcome.
qdrant_prune_old_snapshots

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
  S3_KEY_PATH="${BACKUP_S3_PREFIX:-}onelog-${DATE}.tar.gz.age"
  BUCKET_NAME="${BUCKET_URI#s3://}"
  BUCKET_NAME="${BUCKET_NAME%%/*}"

  # --- Pre-flight: is the endpoint reachable + bucket writable? ---
  # Cheap ListBucket call catches DNS / TLS / auth / bucket-missing before we
  # burn minutes on a doomed multipart upload. Failure here → keep local, retry
  # next cron. Temporarily disable `set -e` so we can inspect the exit code.
  echo "[snapshot] s3 preflight (list bucket)"
  set +e
  aws "${S3_ENDPOINT_ARG[@]}" s3 ls "${BUCKET_URI%/}/" >/dev/null 2>&1
  PREFLIGHT=$?
  set -e
  if [[ "$PREFLIGHT" -ne 0 ]]; then
    echo "[snapshot] WARN S3 preflight failed (exit $PREFLIGHT) — archive kept at $ARCHIVE" >&2
    echo "[snapshot] $(date -Is) done (local-only, S3 skipped)"
    exit 0
  fi

  echo "[snapshot] s3 upload → $S3_KEY"
  set +e
  aws "${S3_ENDPOINT_ARG[@]}" s3 cp "$ARCHIVE" "$S3_KEY" \
    --only-show-errors \
    --metadata "hostname=$(hostname),created=$(date -Iseconds)"
  UPLOAD_RC=$?
  set -e
  if [[ "$UPLOAD_RC" -ne 0 ]]; then
    echo "[snapshot] WARN s3 cp failed (exit $UPLOAD_RC) — archive kept at $ARCHIVE" >&2
    echo "[snapshot] $(date -Is) done (local-only, S3 upload failed)"
    exit 0
  fi

  # --- Post-flight: HEAD the uploaded object, compare byte size ---
  # Some S3-compatible backends (MinIO, custom gateways) have edge cases where
  # multipart upload returns 200 but object listing lags a second or two. Retry
  # a few times before declaring the upload trustworthy enough to drop local.
  LOCAL_SIZE=$(stat -c%s "$ARCHIVE" 2>/dev/null || stat -f%z "$ARCHIVE")
  REMOTE_SIZE=""
  for attempt in 1 2 3 4 5; do
    REMOTE_SIZE=$(aws "${S3_ENDPOINT_ARG[@]}" s3api head-object \
      --bucket "$BUCKET_NAME" --key "$S3_KEY_PATH" \
      --query 'ContentLength' --output text 2>/dev/null || true)
    if [[ -n "$REMOTE_SIZE" && "$REMOTE_SIZE" == "$LOCAL_SIZE" ]]; then break; fi
    sleep 2
  done

  if [[ "$REMOTE_SIZE" != "$LOCAL_SIZE" ]]; then
    echo "[snapshot] WARN s3 verify failed (local=$LOCAL_SIZE remote=${REMOTE_SIZE:-<missing>}) — archive kept at $ARCHIVE" >&2
    echo "[snapshot] $(date -Is) done (local-only, S3 verify failed)"
    exit 0
  fi

  echo "[snapshot] s3 verified ($REMOTE_SIZE bytes match)"
  rm -f "$ARCHIVE"
  echo "[snapshot] local archive purged (uploaded + verified on S3)"

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

# --- Local retention (safety net for stranded archives) ---
# Normal path: local archive was rm'd after S3 upload succeeded, this find is a
# noop. When S3 upload fails (network, creds, endpoint down), the archive stays
# on disk so the next successful run can be triggered manually; this purge only
# evicts *stranded* archives older than KEEP_DAYS to bound disk usage.
find "$BACKUP_DIR" -maxdepth 1 -name 'onelog-*.tar.gz.age' -mtime "+${KEEP_DAYS}" -print -delete || true

echo "[snapshot] $(date -Is) done"
