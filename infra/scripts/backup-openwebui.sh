#!/usr/bin/env bash
# Encrypted backup of OpenWebUI SQLite + config (RT-F4).
#
# Chat history may contain PII from ops pasting raw logs — encrypt-at-rest with
# age. Public key on logserver; private key stays in ops vault so a stolen
# backup file is worthless without the vault key.
#
# Usage:  bash backup-openwebui.sh [BACKUP_DIR]
# Cron:   0 3 * * * /opt/onelog/infra/scripts/backup-openwebui.sh \
#           >> /var/log/openwebui-backup.log 2>&1
# Restore: age -d -i backup-age.key openwebui-YYYYMMDD.tgz.age | tar -xz
#
# Retention: 90 days on logserver (V5). Offsite copy is caller's responsibility.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${INFRA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BACKUP_DIR="${1:-${BACKUP_DIR:-$INFRA_DIR/../backup}}"
AGE_PUBKEY="${AGE_PUBKEY:-/etc/onelog/backup-age.pub}"
KEEP_DAYS="${KEEP_DAYS:-90}"
STAMP="$(date +%Y%m%d-%H%M)"

if [[ ! -f "$AGE_PUBKEY" ]]; then
  echo "[backup-openwebui] FATAL: age public key not found at $AGE_PUBKEY" >&2
  echo "  Generate with: age-keygen -o backup-age.key" >&2
  echo "  Then split: cp backup-age.key /root/vault/ && grep 'public key' backup-age.key > $AGE_PUBKEY" >&2
  exit 1
fi

if ! command -v age >/dev/null 2>&1; then
  echo "[backup-openwebui] FATAL: age not installed. sudo apt install age" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/openwebui-$STAMP.tgz.age"

echo "[backup-openwebui] $(date -Is) start → $OUT"

# Stream tar → age → file. Avoid intermediate plaintext on disk.
# `docker compose exec -T` disables TTY so stdout is raw bytes.
docker compose -f "$INFRA_DIR/docker-compose.yml" exec -T openwebui \
  tar -cz -C /app/backend/data . \
  | age -R "$AGE_PUBKEY" > "$OUT"

SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
if [[ "$SIZE" -lt 1024 ]]; then
  echo "[backup-openwebui] FATAL: output file suspiciously small ($SIZE bytes)" >&2
  rm -f "$OUT"
  exit 1
fi

echo "[backup-openwebui] ok — $OUT ($SIZE bytes)"

# Retention
find "$BACKUP_DIR" -name "openwebui-*.tgz.age" -type f -mtime +"$KEEP_DAYS" -delete
echo "[backup-openwebui] $(date -Is) done — retention: kept last $KEEP_DAYS days"
