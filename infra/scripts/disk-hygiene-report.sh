#!/usr/bin/env bash
# Weekly disk hygiene report — post to Telegram.
#
# Ưu tiên visibility, không auto-fix. Ops đọc → quyết định action.
# Chạy Sunday 08:00 ICT (01:00 UTC) qua systemd timer.
#
# Plan 260904-1336-onelog-scale-hardening-v1 phase 01.

set -euo pipefail

INFRA_DIR="${INFRA_DIR:-/opt/onelog/infra}"
DATA_DIR="${DATA_DIR:-$INFRA_DIR/data}"

if [[ -f "$INFRA_DIR/.env" ]]; then
  set -a; . "$INFRA_DIR/.env"; set +a
fi

TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TG_CHAT="${TELEGRAM_ALERT_CHAT_ID:-}"

hostname_short=$(hostname -s)
ts=$(date -Is)

# --- Gather ---
root_disk=$(df -h / | awk 'NR==2 {print $3 " / " $2 " (" $5 ")"}')

data_volumes=$(du -sh "$DATA_DIR"/*/ 2>/dev/null \
  | sort -rh \
  | head -10 \
  | awk '{printf "  %s  %s\n", $1, $2}')

top_container_logs=$(du -sh /var/lib/docker/containers/*/*.log 2>/dev/null \
  | sort -rh | head -5 | while read size path; do
    cid=$(basename "$(dirname "$path")")
    name=$(docker inspect --format '{{.Name}}' "$cid" 2>/dev/null | sed 's|^/||')
    printf "  %s  %s\n" "$size" "${name:-$cid}"
  done)

# Qdrant status (if reachable)
qdrant_status="n/a"
if [[ -n "${QDRANT_API_KEY:-}" ]]; then
  qdrant_status=$(curl -sS --max-time 5 -H "api-key: $QDRANT_API_KEY" \
    "http://127.0.0.1:6333/collections/log_templates" 2>/dev/null \
    | python3 -c 'import json,sys;d=json.load(sys.stdin)["result"];print(f"status={d[\"status\"]} points={d[\"points_count\"]} segments={d[\"segments_count\"]}")' \
    2>/dev/null || echo "unreachable")
fi

# VL retention: partition count (each = 1 day)
vl_partitions=$(ls "$DATA_DIR/victorialogs/partitions/" 2>/dev/null | wc -l)

# --- Compose ---
report=$(cat <<EOF
📊 OneLog disk hygiene — ${hostname_short} @ ${ts}

Root: ${root_disk}

Top data volumes:
${data_volumes}

Top container logs (24h+):
${top_container_logs}

Qdrant: ${qdrant_status}
VL partitions: ${vl_partitions} (retention 7d target)
EOF
)

echo "$report"

# --- Send ---
if [[ -z "$TG_TOKEN" || -z "$TG_CHAT" ]]; then
  echo "[disk-hygiene] TELEGRAM_BOT_TOKEN/CHAT_ID empty — printed only, no push" >&2
  exit 0
fi

curl -sS --max-time 10 \
  -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
  -d chat_id="${TG_CHAT}" \
  --data-urlencode "text=${report}" \
  > /dev/null

echo "[disk-hygiene] sent to Telegram"
