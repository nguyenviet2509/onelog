#!/usr/bin/env bash
# Daily snapshot of ALL OneLog state — encrypted with age, STREAMED to S3.
# Covers: Qdrant snapshot, VictoriaLogs, VictoriaMetrics, OpenWebUI (SQLite +
#         files), Grafana (SQLite + provisioning), NATS JetStream, alertmanager,
#         audit logs, indexer state, secrets (.env + Caddy TLS + mcp-tokens).
# Excluded: Vector disk buffer (transient checkpoints), Postgres (decommissioned;
#           dormant block kept in case it's ever resurrected).
# Output is age-encrypted (asymmetric) so leaking S3 creds does NOT expose data.
# Usage:  bash snapshot-daily.sh
# Cron:   0 2 * * * /opt/onelog/infra/scripts/snapshot-daily.sh >> /var/log/onelog-snapshot.log 2>&1
#
# Architecture (2026-09-10 refactor to streaming):
#   Zero local archive — tar → gzip → age → aws s3 cp piped in a single stream.
#   Peak disk usage = $STAGE (~100MB for secrets + manifest + Qdrant snapshot
#   symlinks), independent of backup size. Fleet can grow to 500 host without
#   ever pressuring disk. Previous version required ~30GB free (staging + local
#   archive) → cascading disk-full incident 2026-08-27 → 2026-09-10.
#
# Trade-offs vs previous version:
#   + Backup never fails from disk pressure (only ~100MB tmp needed)
#   + No local orphan files to clean up
#   - Restore requires S3 download (~15 min for 20GB @ 20MB/s) — no fast local path
#   - Integrity verify = HeadObject existence + ContentLength > 0 (not byte-match).
#     Rely on aws-cli multipart MD5 (per part) + age auth tag (chacha20-poly1305)
#     for corruption detection at restore.
#
# Retention:
#   S3    → BACKUP_S3_KEEP_DAYS in infra/.env (recommended: 5-7).
#   Local → NONE (script never creates a local archive file).
#
# Prereq: age binary + infra/backup/backup-age.pub committed. See infra/backup/README.md.

set -euo pipefail
set -o pipefail  # explicit for stream pipeline exit-code propagation

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${INFRA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DATE="$(date +%Y%m%d-%H%M)"
STAGE="$(mktemp -d -t ragsnap.XXXXXX)"

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# ─── Pre-flight disk check ───────────────────────────────────────────────
# Only $STAGE tmp needed now (~100MB for secrets + manifest + Qdrant symlink
# metadata). Streaming architecture = no local archive to size for.
STAGE_PARENT=$(dirname "$STAGE")
AVAIL_KB=$(df --output=avail "$STAGE_PARENT" | tail -1)
REQUIRED_KB=$((100 * 1024))  # 100MB — trivially small
if [[ "$AVAIL_KB" -lt "$REQUIRED_KB" ]]; then
  echo "[snapshot] ERROR pre-flight: need ${REQUIRED_KB}KB free in $STAGE_PARENT, have ${AVAIL_KB}KB" >&2
  echo "[snapshot] $(date -Is) ABORT (insufficient disk for stage tmp)"
  exit 3
fi
echo "[snapshot] pre-flight OK (stage tmp $STAGE_PARENT: $((AVAIL_KB / 1024))MB free, need 100MB)"

# Load env (POSTGRES_USER, QDRANT_API_KEY, BACKUP_S3_*, AWS_*)
if [[ -f "$INFRA_DIR/.env" ]]; then
  set -a; . "$INFRA_DIR/.env"; set +a
fi

echo "[snapshot] $(date -Is) start (streaming architecture, DATE=$DATE)"

# --- 1. Postgres logical dump — only when container is running ---
# Postgres decommissioned 2026-07-17. Dormant block: skips cleanly on stacks
# without it, activates automatically if profile `kb` ever comes back.
echo "[1/6] pg_dump"
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

# --- 2. Qdrant snapshot API + symlink into $STAGE ---
# Trigger snapshot API, then symlink from bind-mounted host path to $STAGE/qdrant/<col>/<snap>.
# tar -h (below) dereferences symlinks so archive contains real snapshot bytes.
# Bind mount: infra/docker-compose.yml qdrant service → ./data/qdrant/snapshots
# = /qdrant/snapshots (Phase B fix 2026-09-10). Snapshots visible on host = zero
# copy overhead vs old script's curl -o download.
echo "[2/6] qdrant snapshots"
QDRANT_URL="http://127.0.0.1:6333"
QDRANT_SNAP_HOST="$INFRA_DIR/data/qdrant/snapshots"
COLS_JSON=$(curl -fsS -H "api-key: ${QDRANT_API_KEY:-}" "$QDRANT_URL/collections" || echo '')
if command -v jq >/dev/null 2>&1; then
  COLLECTIONS=$(printf '%s' "$COLS_JSON" | jq -r '.result.collections[].name' 2>/dev/null || true)
else
  COLLECTIONS=$(printf '%s' "$COLS_JSON" | tr ',' '\n' | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' || true)
fi

# Track fresh snapshots (col|name pairs) for prune-old step.
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
      SNAP_PATH="$QDRANT_SNAP_HOST/$col/$SNAP"
      if [[ -f "$SNAP_PATH" ]]; then
        mkdir -p "$STAGE/qdrant/$col"
        ln -s "$SNAP_PATH" "$STAGE/qdrant/$col/$SNAP"
        QDRANT_FRESH_SNAPS+="${col}|${SNAP}"$'\n'
      else
        echo "  warn: snapshot $SNAP not found at $SNAP_PATH (bind-mount misconfigured?)" >&2
      fi
    fi
  done <<< "$COLLECTIONS"
fi

# Prune helper: rolling replace — giữ snapshot mới nhất per collection.
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
qdrant_prune_old_snapshots

# --- 3. Secrets bundle + MANIFEST ---
# Bundle .env + caddy TLS + alertmanager + mcp-tokens so a fresh VPS can boot
# stack immediately after restore. Whole archive age-encrypted at pack step.
echo "[3/6] secrets bundle + manifest"
mkdir -p "$STAGE/secrets"
[[ -f "$INFRA_DIR/.env" ]] && cp -p "$INFRA_DIR/.env" "$STAGE/secrets/env"
for d in caddy/data caddy/config alertmanager mcp-tokens; do
  if [[ -d "$INFRA_DIR/$d" ]]; then
    # Flatten path separator so restore can iterate *.tar without ambiguity.
    tar -C "$INFRA_DIR" -cf "$STAGE/secrets/${d//\//_}.tar" "$d" 2>/dev/null || true
  fi
done

GIT_COMMIT=$(cd "$INFRA_DIR/.." && git rev-parse HEAD 2>/dev/null || echo unknown)
IMAGE_TAGS=$(cd "$INFRA_DIR" && docker compose config --images 2>/dev/null | sort -u | paste -sd, - || echo unknown)
HAS_SECRETS=$([[ -f "$STAGE/secrets/env" ]] && echo true || echo false)
cat > "$STAGE/MANIFEST.json" <<EOF
{
  "version": 2,
  "format": "streaming",
  "created": "$(date -Iseconds)",
  "hostname": "$(hostname)",
  "git_commit": "$GIT_COMMIT",
  "image_tags": "$IMAGE_TAGS",
  "has_secrets": $HAS_SECRETS
}
EOF

# --- 4. Pack + age encrypt + STREAM to S3 (single pipeline) ---
# Archive layout (streaming format, MANIFEST version 2):
#   ./MANIFEST.json
#   ./secrets/env
#   ./secrets/{caddy_data,caddy_config,alertmanager,mcp-tokens}.tar
#   ./qdrant/<collection>/<snapshot-file>        ← dereferenced symlinks
#   ./victorialogs/... (raw dir contents)
#   ./nats/... (raw dir contents)
#   ./victoriametrics/... (raw dir contents)
#   ./openwebui/... (raw dir contents)
#   ./grafana/... (raw dir contents)
#   ./alertmanager/... (raw dir contents)
#   ./audit/... (raw dir contents)
#   ./indexer/... (raw dir contents)
#   ./postgres-rag.sql (if postgres was running)
#
# Old archive format (version 1, pre-2026-09-10): had per-service .tar files
# instead of raw dirs. restore-snapshot.sh auto-detects both formats.
echo "[4/6] pack + encrypt + stream"

AGE_PUB="${BACKUP_AGE_PUB:-$INFRA_DIR/backup/backup-age.pub}"
if [[ ! -f "$AGE_PUB" ]]; then
  echo "[snapshot] ERROR age public key missing: $AGE_PUB" >&2
  exit 5
fi
if ! command -v age >/dev/null 2>&1; then
  echo "[snapshot] ERROR age binary missing (apt install age)" >&2
  exit 6
fi
if [[ "${BACKUP_S3_ENABLE:-false}" != "true" ]]; then
  echo "[snapshot] ERROR streaming architecture requires BACKUP_S3_ENABLE=true" >&2
  echo "[snapshot] (no local file mode not supported — reset to Phase B script if needed)" >&2
  exit 7
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "[snapshot] ERROR aws cli missing" >&2
  exit 4
fi
: "${BACKUP_S3_BUCKET:?Set BACKUP_S3_BUCKET when BACKUP_S3_ENABLE=true}"

S3_ENDPOINT_ARG=()
[[ -n "${BACKUP_S3_ENDPOINT:-}" ]] && S3_ENDPOINT_ARG+=(--endpoint-url "$BACKUP_S3_ENDPOINT")

BUCKET_URI="$BACKUP_S3_BUCKET"
[[ "$BUCKET_URI" != s3://* ]] && BUCKET_URI="s3://$BUCKET_URI"
S3_KEY="${BUCKET_URI%/}/${BACKUP_S3_PREFIX:-}onelog-${DATE}.tar.gz.age"
S3_KEY_PATH="${BACKUP_S3_PREFIX:-}onelog-${DATE}.tar.gz.age"
BUCKET_NAME="${BUCKET_URI#s3://}"
BUCKET_NAME="${BUCKET_NAME%%/*}"

# --- S3 preflight (list bucket) — abort BEFORE spending minutes on doomed stream ---
echo "[snapshot] s3 preflight (list bucket)"
if ! aws "${S3_ENDPOINT_ARG[@]}" s3 ls "${BUCKET_URI%/}/" >/dev/null 2>&1; then
  echo "[snapshot] ERROR S3 preflight failed — check endpoint/creds/bucket" >&2
  echo "[snapshot] $(date -Is) ABORT (S3 unreachable)"
  exit 8
fi

# --- Estimate size for aws multipart chunk sizing ---
# Query last successful upload from S3 as size hint. Fallback 25GB if none.
LAST_S3_SIZE=$(aws "${S3_ENDPOINT_ARG[@]}" s3api list-objects-v2 \
  --bucket "$BUCKET_NAME" --prefix "${BACKUP_S3_PREFIX:-}" \
  --query 'sort_by(Contents, &LastModified)[-1].Size' --output text 2>/dev/null || echo "")
[[ -z "$LAST_S3_SIZE" || "$LAST_S3_SIZE" == "None" ]] && LAST_S3_SIZE=25000000000

echo "[snapshot] s3 upload (streaming) → $S3_KEY (expected ~$((LAST_S3_SIZE / 1073741824))GB)"

# The pipeline. tar -h dereferences the Qdrant symlinks. --warning=no-file-changed
# and --ignore-failed-read tolerate hot-copy of live SQLite/RocksDB. `set -o
# pipefail` propagates any component's non-zero exit to the whole pipeline exit.
set +e
tar --warning=no-file-changed --ignore-failed-read \
    -h -C "$STAGE" --create . \
    -C "$INFRA_DIR/data" \
      victorialogs victoriametrics openwebui grafana nats alertmanager audit indexer \
  | gzip \
  | age -R "$AGE_PUB" \
  | aws "${S3_ENDPOINT_ARG[@]}" s3 cp - "$S3_KEY" \
      --expected-size "$LAST_S3_SIZE" \
      --only-show-errors \
      --metadata "hostname=$(hostname),created=$(date -Iseconds)"
UPLOAD_RC=$?
set -e

if [[ "$UPLOAD_RC" -ne 0 ]]; then
  echo "[snapshot] ERROR streaming pipeline exit $UPLOAD_RC" >&2
  echo "[snapshot] $(date -Is) FAILED (partial upload aborted by S3, no local file to clean)"
  exit "$UPLOAD_RC"
fi

# --- 5. Verify S3 object exists (streaming = no byte-level compare, only existence) ---
# aws s3 cp already validates multipart MD5 per chunk on success return.
# HeadObject confirms server-side persistence + fetches size for logging.
echo "[5/6] verify S3 upload"
REMOTE_SIZE=""
for attempt in 1 2 3 4 5; do
  REMOTE_SIZE=$(aws "${S3_ENDPOINT_ARG[@]}" s3api head-object \
    --bucket "$BUCKET_NAME" --key "$S3_KEY_PATH" \
    --query 'ContentLength' --output text 2>/dev/null || true)
  if [[ -n "$REMOTE_SIZE" && "$REMOTE_SIZE" != "None" && "$REMOTE_SIZE" -gt 0 ]]; then break; fi
  sleep 2
done

if [[ -z "$REMOTE_SIZE" || "$REMOTE_SIZE" == "None" || "$REMOTE_SIZE" -le 0 ]]; then
  echo "[snapshot] ERROR S3 verify failed — HeadObject returned no size after 5 tries" >&2
  echo "[snapshot] $(date -Is) FAILED (upload succeeded but object missing/empty)"
  exit 9
fi

echo "[snapshot] s3 verified (remote size: $((REMOTE_SIZE / 1048576))MB)"

# --- 6. Remote retention (best-effort) ---
# Prefer bucket lifecycle rule for real S3 (cheap + reliable).
# The KEEP_DAYS purge below is a fallback for MinIO buckets w/o lifecycle.
echo "[6/6] remote retention"
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
else
  echo "  (BACKUP_S3_KEEP_DAYS=0 — retention delegated to bucket lifecycle rule)"
fi

echo "[snapshot] $(date -Is) done"
