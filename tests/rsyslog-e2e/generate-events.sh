#!/usr/bin/env bash
# Generate 1000 events via the test rsyslog container's logger.
# 999 normal info events + 1 WARN event with PII to verify redaction.
set -euo pipefail

CONTAINER="${CONTAINER:-onelog-e2e-rsyslog-client}"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "Container ${CONTAINER} not running. Bring up with:"
  echo "  docker compose -f tests/rsyslog-e2e/docker-compose.test.yml up -d --build"
  exit 1
fi

echo "Sending 999 normal events..."
for i in $(seq 1 999); do
  docker exec "$CONTAINER" logger -t demo-svc -p user.info "test event $i normal payload"
done

echo "Sending 1 PII event (email + private IP)..."
docker exec "$CONTAINER" logger -t demo-svc -p user.warn \
  "user admin@example.com login from 192.168.1.50"

echo "Sent 1000 events total. Wait a few seconds for Vector flush, then run verify.sh."
