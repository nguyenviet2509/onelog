#!/usr/bin/env bash
# Resurrect drill — verify the `legacy-web` branch still boots.
#
# Phase 02 step 5b. Run on a sandbox (NOT prod) shortly after decommission and
# again at the Phase 03 review checkpoint. If the drill ever fails, fix the
# pinning on legacy-web BEFORE letting the decommission age further.
#
# Prereqs:
#   - Sandbox / scratch machine with docker compose + git
#   - Clone or worktree of the repo at $REPO_DIR (default current dir)
#   - Network can reach Docker Hub + ghcr.io for image pulls
#
# Usage:
#   ./resurrect-drill.sh                       # run from repo root
#   REPO_DIR=/tmp/onelog-drill BRANCH=legacy-web ./resurrect-drill.sh
#
# Outputs:
#   - time-to-bootable (target <30 min)
#   - infra/RESURRECT-NOTES.md with timing + any deviations
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(pwd)}"
BRANCH="${BRANCH:-legacy-web}"
NOTES="$REPO_DIR/infra/RESURRECT-NOTES.md"
START=$(date +%s)

cd "$REPO_DIR"

echo "▶ Drill start $(date -Iseconds) — branch=$BRANCH"

echo "▶ Step 1: checkout $BRANCH"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH" || true

echo "▶ Step 2: ensure mock LLM (no real API key needed)"
cd infra
cp -n .env .env.drill.bak 2>/dev/null || true
# Force mock so drill doesn't burn Anthropic / OpenAI quota
{
  grep -v '^LLM_MOCK=' .env | grep -v '^EMBED_MOCK=' || true
  echo "LLM_MOCK=true"
  echo "EMBED_MOCK=true"
} > .env.drill && mv .env.drill .env

echo "▶ Step 3: build + start web + agent under their profiles"
docker compose --profile web --profile agent build web agent
docker compose --profile web --profile agent up -d web agent

echo "▶ Step 4: wait up to 60s for web :3000 + agent :8080 healthy"
deadline=$(( $(date +%s) + 60 ))
web_ok=0; agent_ok=0
while [[ $(date +%s) -lt $deadline ]]; do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/; then web_ok=1; fi
  if curl -fsS -o /dev/null http://127.0.0.1:8080/health 2>/dev/null \
     || curl -fsS -o /dev/null http://127.0.0.1:8080/; then agent_ok=1; fi
  if [[ $web_ok -eq 1 && $agent_ok -eq 1 ]]; then break; fi
  sleep 2
done

echo "▶ Step 5: smoke 1 mock chat request"
chat_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -X POST http://127.0.0.1:8080/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"hello"}' || echo "fail")

END=$(date +%s)
ELAPSED=$(( END - START ))
ELAPSED_MIN=$(( ELAPSED / 60 ))

mkdir -p "$(dirname "$NOTES")"
cat >> "$NOTES" <<EOF

## Drill $(date -Iseconds)
- Branch: $BRANCH
- Elapsed: ${ELAPSED}s (~${ELAPSED_MIN} min, target <30 min)
- web bootable: $([[ $web_ok -eq 1 ]] && echo yes || echo no)
- agent bootable: $([[ $agent_ok -eq 1 ]] && echo yes || echo no)
- mock /chat status: $chat_status
EOF

echo
echo "═══════════════════════════════════════════════════════"
echo "Resurrect drill complete."
echo "Elapsed: ${ELAPSED}s (~${ELAPSED_MIN} min)"
echo "web=$web_ok agent=$agent_ok chat=$chat_status"
echo "Notes appended to $NOTES"
echo
echo "Restore: cp infra/.env.drill.bak infra/.env && docker compose --profile web --profile agent down"
echo "═══════════════════════════════════════════════════════"

if [[ $web_ok -ne 1 || $agent_ok -ne 1 ]]; then
  echo "✗ DRILL FAILED — service(s) did not boot. Fix lockfiles on $BRANCH before next drill." >&2
  exit 1
fi
echo "✓ DRILL PASS"
