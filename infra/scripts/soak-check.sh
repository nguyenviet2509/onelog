#!/usr/bin/env bash
set -u
cd ~/onelog/infra

echo "=== Health ===" 
curl -s http://localhost:3000/api/admin/health | jq -c '.checks[] | {name, ok, latency_ms}'

echo "=== Indexer metrics ==="
curl -s http://localhost:9100/metrics | grep -E '^indexer_(consumed|embedded|upserted|errors)_total' | head

echo "=== Qdrant points ==="
curl -s http://localhost:6333/collections/log_templates | jq '.result.points_count'

echo "=== Audit by source ==="
curl -s 'http://localhost:3000/api/admin/audit?limit=100' \
  | jq '.rows | group_by(.source) | map({source: .[0].source, count: length})'

echo "=== Firing alerts (24h) ==="
docker compose logs --since 24h alertmanager 2>&1 | grep -c firing

echo "=== Container status ==="
docker compose ps --format '{{.Name}} {{.State}} {{.Status}}' | grep -vE 'running|Up'

echo "=== Disk ==="
df -h /var/lib/docker | tail -1
sudo du -sh data/* 2>/dev/null
