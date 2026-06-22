#!/usr/bin/env bash
# Setup ragstack on a fresh Ubuntu 22.04/24.04 VM
# Usage: sudo bash setup-log-server.sh
set -euo pipefail

echo "[1/6] Install Docker + compose plugin"
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "[2/6] Firewall (UFW)"
ufw --force enable
ufw allow 22/tcp comment "ssh"
ufw allow 514/udp comment "syslog ingest"
ufw allow 6514/tcp comment "syslog tls"
ufw allow 80/tcp  comment "http"
ufw allow 443/tcp comment "https"

echo "[3/6] Prepare directories"
INFRA_DIR="${INFRA_DIR:-/opt/ragstack}"
mkdir -p "$INFRA_DIR"/{data/{victorialogs,qdrant,postgres,redis,vector},caddy/{data,config}}
echo "Note: copy docker-compose.yml, .env, caddy/, vector/, mockups/ into $INFRA_DIR"

echo "[4/6] Generate strong passwords (write to .env yourself)"
echo "QDRANT_API_KEY=$(openssl rand -hex 32)"
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "REDIS_PASSWORD=$(openssl rand -hex 24)"

echo "[5/6] Bring up stack"
echo "cd $INFRA_DIR && docker compose up -d"

echo "[6/6] Verify"
echo "curl http://localhost:9428/health    # VictoriaLogs"
echo "curl http://localhost:6333/healthz   # Qdrant"
echo "curl http://localhost:8686/health    # Vector"
echo "logger -n LOG_SERVER_IP -P 514 'test from $(hostname)'  # syslog ingest test"
echo
echo "Done. Next: configure 3 demo servers with infra/clients/rsyslog-forward.conf"
