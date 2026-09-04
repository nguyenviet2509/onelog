#!/usr/bin/env bash
# Emit onelog_data_volume_bytes{volume=...} + onelog_container_log_bytes{container=...}
# metrics via node-exporter textfile collector.
#
# Chạy 5 phút / lần qua systemd timer. Atomic write (temp + mv) tránh
# node-exporter đọc file partial.
#
# Plan 260904-1336-onelog-scale-hardening-v1 phase 01.

set -euo pipefail

INFRA_DIR="${INFRA_DIR:-/opt/onelog/infra}"
DATA_DIR="${DATA_DIR:-$INFRA_DIR/data}"
OUT_DIR="${OUT_DIR:-$DATA_DIR/textfile_collector}"
OUT_FILE="$OUT_DIR/onelog_du.prom"
TMP_FILE="$OUT_FILE.$$.tmp"

mkdir -p "$OUT_DIR"

emit_header() {
  cat <<EOF > "$TMP_FILE"
# HELP onelog_data_volume_bytes Size in bytes of each onelog data volume.
# TYPE onelog_data_volume_bytes gauge
EOF
}

emit_volumes() {
  # du -sb (byte-accurate) — chỉ scan 1-level subdirs, exclude junk.
  for d in "$DATA_DIR"/*/; do
    name=$(basename "$d")
    # Skip textfile_collector itself + non-service dirs
    [[ "$name" == "textfile_collector" ]] && continue
    size=$(du -sb "$d" 2>/dev/null | awk '{print $1}')
    [[ -z "$size" ]] && continue
    echo "onelog_data_volume_bytes{volume=\"$name\"} $size" >> "$TMP_FILE"
  done
}

emit_container_logs() {
  cat <<'EOF' >> "$TMP_FILE"
# HELP onelog_container_log_bytes Size in bytes of docker json log file per container.
# TYPE onelog_container_log_bytes gauge
EOF
  # Map container id → name, then measure its json log file.
  # docker inspect required (jq optional — use format string).
  for cid in $(docker ps -q); do
    name=$(docker inspect --format '{{.Name}}' "$cid" 2>/dev/null | sed 's|^/||')
    [[ -z "$name" ]] && continue
    log_path="/var/lib/docker/containers/$cid/$cid-json.log"
    if [[ -f "$log_path" ]]; then
      size=$(stat -c '%s' "$log_path" 2>/dev/null || echo 0)
      echo "onelog_container_log_bytes{container=\"$name\"} $size" >> "$TMP_FILE"
    fi
  done
}

emit_header
emit_volumes
emit_container_logs

# Atomic swap — node-exporter never reads half-written file.
chmod 0644 "$TMP_FILE"
mv "$TMP_FILE" "$OUT_FILE"
