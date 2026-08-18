#!/usr/bin/env bash
# Prune Qdrant log_templates points có window_start cũ hơn RETENTION_DAYS.
# Chạy daily qua systemd timer. Idempotent — no-op nếu không có point nào cũ.
#
# Usage:
#   bash qdrant-log-templates-prune.sh                # default RETENTION_DAYS=30
#   RETENTION_DAYS=14 bash qdrant-log-templates-prune.sh
#   DRY_RUN=1 bash qdrant-log-templates-prune.sh      # chỉ đếm, không xóa
#
# Math: 1536-dim × ~13KB/point → 500k points ≈ 6.5GB RAM (hard cap Qdrant).
# Với fleet 50-host + Fix 1 (Vector noise scrub) baseline ~2-3k/day →
# 30d retention ≈ 90k points ≈ 1.2GB. Comfortable dưới hard cap.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${INFRA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

if [[ -f "$INFRA_DIR/.env" ]]; then
  set -a; . "$INFRA_DIR/.env"; set +a
fi

QDRANT_URL="${QDRANT_URL:-http://127.0.0.1:6333}"
COLLECTION="${COLLECTION:-log_templates}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DRY_RUN="${DRY_RUN:-0}"

if [[ -z "${QDRANT_API_KEY:-}" ]]; then
  echo "[prune] ERROR: QDRANT_API_KEY not set (check $INFRA_DIR/.env)" >&2
  exit 1
fi

CUTOFF="$(date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)"
FILTER=$(cat <<EOF
{"filter": {"must": [{"key": "window_start", "range": {"lt": "${CUTOFF}"}}]}}
EOF
)

echo "[prune] $(date -Is) collection=${COLLECTION} cutoff=${CUTOFF} dry_run=${DRY_RUN}"

# Count matches trước khi xóa (visibility + safety check).
COUNT_BODY=$(cat <<EOF
{"filter": {"must": [{"key": "window_start", "range": {"lt": "${CUTOFF}"}}]}, "exact": true}
EOF
)
count_resp="$(curl -sS -H "api-key: ${QDRANT_API_KEY}" -H "Content-Type: application/json" \
  -X POST "${QDRANT_URL}/collections/${COLLECTION}/points/count" \
  -d "${COUNT_BODY}")"
match_count="$(echo "${count_resp}" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['count'])")"

# Total collection count cho context.
total_resp="$(curl -sS -H "api-key: ${QDRANT_API_KEY}" -H "Content-Type: application/json" \
  -X POST "${QDRANT_URL}/collections/${COLLECTION}/points/count" \
  -d '{"exact": true}')"
total_count="$(echo "${total_resp}" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['count'])")"

echo "[prune] total=${total_count} to_delete=${match_count} keep=$((total_count - match_count))"

if [[ "${match_count}" == "0" ]]; then
  echo "[prune] nothing to prune, exit ok"
  exit 0
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[prune] DRY_RUN=1, skip delete"
  exit 0
fi

# Safety guard: refuse to delete > 50% collection trong 1 lần chạy.
# Điều này chỉ trigger nếu retention thay đổi drastic hoặc bug logic upstream.
half=$((total_count / 2))
if (( match_count > half )); then
  echo "[prune] REFUSE: match_count=${match_count} > 50% of total=${total_count}." >&2
  echo "[prune] Set DRY_RUN=1 để inspect. Hoặc chỉnh RETENTION_DAYS lớn hơn." >&2
  exit 2
fi

del_resp="$(curl -sS -H "api-key: ${QDRANT_API_KEY}" -H "Content-Type: application/json" \
  -X POST "${QDRANT_URL}/collections/${COLLECTION}/points/delete?wait=true" \
  -d "${FILTER}")"
del_status="$(echo "${del_resp}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))")"
echo "[prune] delete status=${del_status}"

# Verify post-delete count.
after_resp="$(curl -sS -H "api-key: ${QDRANT_API_KEY}" -H "Content-Type: application/json" \
  -X POST "${QDRANT_URL}/collections/${COLLECTION}/points/count" \
  -d '{"exact": true}')"
after_count="$(echo "${after_resp}" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['count'])")"
echo "[prune] $(date -Is) done total_after=${after_count} deleted=$((total_count - after_count))"
