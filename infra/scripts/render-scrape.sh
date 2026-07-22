#!/usr/bin/env bash
# Render infra/victoriametrics/scrape.yml from scrape.yml.example, substituting
# secret values (QDRANT_API_KEY, LITELLM_MASTER_KEY) from infra/.env.
#
# Why not use VictoriaMetrics' native -promscrape.configEnvVarsExpansion?
# The flag was removed / renamed in some VM releases; envsubst here keeps
# the deploy independent of VM version. Rendered scrape.yml is gitignored.
#
# Usage:
#   bash infra/scripts/render-scrape.sh          # renders relative to repo
#   INFRA=/opt/onelog/infra bash render-scrape.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA="${INFRA:-$(cd "$SCRIPT_DIR/.." && pwd)}"

ENV_FILE="${INFRA}/.env"
SRC="${INFRA}/victoriametrics/scrape.yml.example"
DST="${INFRA}/victoriametrics/scrape.yml"

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — copy .env.example first"; exit 1; }
[ -f "$SRC" ] || { echo "Missing $SRC"; exit 1; }

# Load .env into environment for envsubst
set -a; . "$ENV_FILE"; set +a

# Only substitute known placeholders — don't let random $ in comments break render.
export QDRANT_API_KEY LITELLM_MASTER_KEY
envsubst '${QDRANT_API_KEY} ${LITELLM_MASTER_KEY}' < "$SRC" > "$DST"

echo "Rendered $DST from $SRC"
grep -E 'credentials:' "$DST" | sed 's/credentials: ".*"/credentials: "<redacted>"/' || true
