#!/usr/bin/env bash
# F. Resilience — verify rsyslog client queue spill when Vector down,
# then drain on Vector recovery.
# REQUIRES: rsyslog test container from docker-compose.test.yml + OneLog stack.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"

TAG="resil-$(date +%s)"
echo "=== F. Resilience (TAG=$TAG) ==="

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "SKIP: rsyslog test container ${CONTAINER} not running."
  echo "Bring up: docker compose -f tests/rsyslog-e2e/docker-compose.test.yml up -d --build"
  exit 0
fi

# Phase 1: vector up — 50 baseline events via container rsyslog
echo "[F1] Baseline 50 events (vector up)..."
for i in $(seq 1 50); do
  docker exec "$CONTAINER" logger -t "$TAG" -p user.info "pre $i"
done
sleep 3
pre_count=$(vl_count "service:$TAG AND _msg:\"pre \"")
echo "  pre events in VL: $pre_count"

# Phase 2: kill vector, send 50 → must spill to client rsyslog queue
echo "[F2] Stopping Vector..."
docker compose -f infra/docker-compose.yml stop vector
sleep 2
echo "  sending 50 during-down events to client rsyslog queue..."
for i in $(seq 1 50); do
  docker exec "$CONTAINER" logger -t "$TAG" -p user.info "during-down $i" || true
done

# Phase 3: restart vector, đợi rsyslog drain
echo "[F3] Restarting Vector + draining (10s)..."
docker compose -f infra/docker-compose.yml start vector
sleep 12

# Phase 4: 50 more post-recovery
echo "[F4] Post-recovery 50 events..."
for i in $(seq 1 50); do
  docker exec "$CONTAINER" logger -t "$TAG" -p user.info "post $i"
done
sleep 5

# Assertions: cho phép drop một số (TCP reset window), require >= 130 total + drained >= 30
total=$(vl_count "service:$TAG")
drained=$(vl_count "service:$TAG AND _msg:\"during-down\"")
post=$(vl_count "service:$TAG AND _msg:\"post \"")

echo "  total=$total drained=$drained post=$post"
assert_ge "$total" "130" "F total events after recovery (>=130 of 150)"
assert_ge "$drained" "30" "F rsyslog queue drained (>=30 of 50)"
assert_ge "$post" "45" "F post-recovery events (>=45 of 50)"

echo "=== F PASS ==="
